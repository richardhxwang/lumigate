#!/bin/sh
# Backtest completion notifier — runs inside freqtrade container
# Usage: bt-notify.sh <log_file> <label>
# Example: bt-notify.sh /freqtrade/user_data/logs/backtest-leverage-pure.log "PureSMC 杠杆"

LOG="$1"
LABEL="${2:-回测}"
TOKEN="8696086454:AAH1GdF25kvVPIIQBCoBUcPzCFwfJlE_TLg"
CHAT="6426301640"

send() {
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="$CHAT" -d parse_mode="HTML" -d text="$1" > /dev/null 2>&1
}

send "📊 <b>${LABEL}</b> 开始运行
系统会自动推送进度和结果，请等待通知"

last_pair=0
last_progress_time=0

while true; do
  sleep 30
  [ ! -f "$LOG" ] && continue

  NOW=$(date +%s)

  # === 进度推送（每换一个新 pair 或每 5 分钟推一次）===
  CUR_PAIR=$(grep -o "[0-9]*/15 pairs" "$LOG" 2>/dev/null | tail -1 | cut -d/ -f1)
  CUR_TRAIN=$(grep -o "[0-9]*/[0-9]* trains" "$LOG" 2>/dev/null | tail -1)
  TOTAL_TRAINS=$(grep -o "/[0-9]* trains" "$LOG" 2>/dev/null | tail -1 | tr -d '/ trains')

  # 换了新 pair 时推送
  if [ -n "$CUR_PAIR" ] && [ "$CUR_PAIR" != "$last_pair" ] && [ "$CUR_PAIR" -gt 0 ] 2>/dev/null; then
    PAIR_NAME=$(grep "${CUR_PAIR}/15 pairs" "$LOG" 2>/dev/null | tail -1 | grep -o "[A-Z]*/USDT" | head -1)
    send "⏳ <b>${LABEL}</b> 训练进度

正在训练第 ${CUR_PAIR}/15 个币种 (${PAIR_NAME:-...})
当前窗口: ${CUR_TRAIN:-?}

完成后会自动通知结果"
    last_pair=$CUR_PAIR
    last_progress_time=$NOW
  fi

  # 同一个 pair 超过 5 分钟没推送，推一次当前进度
  if [ -n "$CUR_TRAIN" ] && [ $((NOW - last_progress_time)) -gt 300 ] 2>/dev/null; then
    if [ "$(find "$LOG" -mmin -1 2>/dev/null)" ]; then
      CUR_NUM=$(echo "$CUR_TRAIN" | cut -d/ -f1)
      if [ -n "$TOTAL_TRAINS" ] && [ "$TOTAL_TRAINS" -gt 0 ] 2>/dev/null; then
        PCT=$((CUR_NUM * 100 / TOTAL_TRAINS))
        send "⏳ <b>${LABEL}</b> 仍在运行中

币种 ${CUR_PAIR:-?}/15 · 训练窗口 ${CUR_TRAIN} · 约 ${PCT}%"
        last_progress_time=$NOW
      fi
    fi
  fi

  # === 完成检测 ===
  if grep -q "^EXIT:" "$LOG" 2>/dev/null; then
    EXIT_CODE=$(grep "^EXIT:" "$LOG" | tail -1 | sed 's/EXIT://')

    if [ "$EXIT_CODE" = "137" ]; then
      send "❌ <b>${LABEL} 内存不足崩溃</b>

Docker 内存不够用了，回测被系统强制终止。
建议：在 Docker Desktop 设置中增加内存分配，或减少同时运行的币种数量。"

    elif [ "$EXIT_CODE" != "0" ]; then
      # 分析具体错误原因
      if grep -q "all training data dropped due to NaNs" "$LOG" 2>/dev/null; then
        PAIR_ERR=$(grep "all training data dropped" "$LOG" | head -1 | grep -o "[A-Z]*/USDT:[A-Z]*" | head -1)
        send "❌ <b>${LABEL} 训练数据不足</b>

${PAIR_ERR:-某个币种} 的历史数据太短，ML 模型没有足够的数据来训练。
建议：下载更早的历史数据（至少比回测起始日期早 2 个月），或把回测起始日期往后推。"

      elif grep -q "NoneType.*predict" "$LOG" 2>/dev/null; then
        send "❌ <b>${LABEL} 模型加载失败</b>

ML 模型文件损坏或与当前回测时间段不匹配。
建议：清除旧模型缓存后重新运行回测。"

      elif grep -q "MemoryError\|Cannot allocate" "$LOG" 2>/dev/null; then
        send "❌ <b>${LABEL} 内存不足</b>

回测过程中内存耗尽。
建议：减少币种数量或增加 Docker 内存。"

      else
        ERR_MSG=$(grep -E "OperationalException|Fatal exception|Error" "$LOG" | tail -1 | head -c 150)
        send "❌ <b>${LABEL} 运行出错</b>

错误信息：${ERR_MSG:-未知错误}
请检查日志文件排查问题。"
      fi

    else
      # 成功！提取关键指标
      CAGR=$(grep "CAGR" "$LOG" | tail -1 | grep -o "[0-9.]*%" | head -1)
      SHARPE=$(grep "Sharpe" "$LOG" | tail -1 | grep -o "[0-9.]*" | head -1)
      PROFIT_PCT=$(grep "Total profit %" "$LOG" | tail -1 | grep -o "[0-9.]*%" | head -1)
      PF=$(grep "Profit factor" "$LOG" | tail -1 | grep -o "[0-9.]*" | head -1)
      FINAL=$(grep "Final balance" "$LOG" | tail -1 | grep -o "[0-9.]* USDT" | head -1)
      TRADES=$(grep "Total/Daily" "$LOG" | tail -1 | grep -o "[0-9]* /" | head -1 | tr -d ' /')
      DD=$(grep "Drawdown" "$LOG" | head -1 | grep -o "[0-9.]*%" | tail -1)

      send "✅ <b>${LABEL} 完成！</b>

📈 总收益: ${PROFIT_PCT:-?}
📊 年化收益 (CAGR): ${CAGR:-?}
⚡ Sharpe 比率: ${SHARPE:-?}
💰 盈亏比: ${PF:-?}
📉 最大回撤: ${DD:-?}
🔢 总交易数: ${TRADES:-?}
💵 最终余额: ${FINAL:-?}

(从 10,000 USDT 起始)"
    fi

    exit 0
  fi
done

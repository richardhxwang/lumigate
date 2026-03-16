# Whisper STT Server

轻量语音转文字服务，基于 faster-whisper，兼容 OpenAI Whisper API。

## 安装

```bash
pip3 install -r requirements.txt
```

## 启动

```bash
# Mac Mini 本地
python3 server.py

# 指定模型 (tiny/base/small/medium/large-v3)
WHISPER_MODEL=small python3 server.py

# 指定端口
PORT=17863 python3 server.py
```

## 使用

```bash
# 转写
curl -X POST http://localhost:17863/asr -F file=@audio.wav

# OpenAI 兼容格式
curl -X POST http://localhost:17863/v1/audio/transcriptions -F file=@audio.mp3

# 翻译到英文
curl -X POST http://localhost:17863/v1/audio/translations -F file=@chinese.wav
```

## LumiGate 集成

在 `.env` 中设置:
```
WHISPER_URL=http://host.docker.internal:17863
```

NAS 部署时指向 Mac Mini IP:
```
WHISPER_URL=http://192.168.1.xxx:17863
```

## 模型大小

| 模型 | 大小 | 速度 | 准确度 |
|------|------|------|--------|
| tiny | 39 MB | 极快 | 一般 |
| base | 74 MB | 快 | 较好 |
| small | 244 MB | 中 | 好 |
| medium | 769 MB | 慢 | 很好 |
| large-v3 | 1.5 GB | 很慢 | 最好 |

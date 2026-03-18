#!/usr/bin/env bash
set -euo pipefail

ROOT_DB="/Volumes/SSD Acer M7000/MacMini-Data/Projects/Project/General/pocketbase/pb_data/data.db"
PROJ_DB="/Volumes/SSD Acer M7000/MacMini-Data/Projects/Project/General/pocketbase/pb_data/projects/lumichat/data.db"

ensure_column() {
  local db="$1" table="$2" col="$3" col_def="$4"
  local exists
  exists=$(sqlite3 "$db" "select count(1) from pragma_table_info('$table') where name='$col';")
  if [[ "$exists" != "0" ]]; then
    return 0
  fi
  sqlite3 "$db" "alter table $table add column $col $col_def;"
}

ensure_field_json() {
  local db="$1" coll="$2" field_name="$3" field_json="$4"
  local exists
  exists=$(sqlite3 "$db" "select count(1) from _collections c, json_each(c.fields) je where c.name='$coll' and json_extract(je.value, '$.name')='$field_name';")
  if [[ "$exists" != "0" ]]; then
    return 0
  fi
  sqlite3 "$db" "update _collections set fields=json_insert(fields, '\$[#]', json('$field_json')), updated=strftime('%Y-%m-%d %H:%M:%fZ') where name='$coll';"
}

sync_one_db() {
  local db="$1"
  ensure_column "$db" "lc_files" "original_name" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_files" "ext" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_files" "kind" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_files" "parse_status" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_files" "parse_error" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_files" "parsed_at" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_files" "created_at" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_files" "updated_at" "TEXT NOT NULL DEFAULT ''"

  ensure_column "$db" "lc_sessions" "created_at" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_sessions" "updated_at" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_messages" "created_at" "TEXT NOT NULL DEFAULT ''"
  ensure_column "$db" "lc_messages" "updated_at" "TEXT NOT NULL DEFAULT ''"

  ensure_field_json "$db" "lc_files" "original_name" '{"autogeneratePattern":"","hidden":false,"id":"text_file_original_name","max":0,"min":0,"name":"original_name","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_files" "ext" '{"autogeneratePattern":"","hidden":false,"id":"text_file_ext","max":32,"min":0,"name":"ext","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_files" "kind" '{"autogeneratePattern":"","hidden":false,"id":"text_file_kind","max":32,"min":0,"name":"kind","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_files" "parse_status" '{"autogeneratePattern":"","hidden":false,"id":"text_file_parse_status","max":32,"min":0,"name":"parse_status","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_files" "parse_error" '{"autogeneratePattern":"","hidden":false,"id":"text_file_parse_error","max":5000,"min":0,"name":"parse_error","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_files" "parsed_at" '{"autogeneratePattern":"","hidden":false,"id":"text_file_parsed_at","max":0,"min":0,"name":"parsed_at","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_files" "created_at" '{"autogeneratePattern":"","hidden":false,"id":"text_file_created_at","max":0,"min":0,"name":"created_at","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_files" "updated_at" '{"autogeneratePattern":"","hidden":false,"id":"text_file_updated_at","max":0,"min":0,"name":"updated_at","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'

  ensure_field_json "$db" "lc_sessions" "created_at" '{"autogeneratePattern":"","hidden":false,"id":"text_sess_created_at","max":0,"min":0,"name":"created_at","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_sessions" "updated_at" '{"autogeneratePattern":"","hidden":false,"id":"text_sess_updated_at","max":0,"min":0,"name":"updated_at","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_messages" "created_at" '{"autogeneratePattern":"","hidden":false,"id":"text_msg_created_at","max":0,"min":0,"name":"created_at","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
  ensure_field_json "$db" "lc_messages" "updated_at" '{"autogeneratePattern":"","hidden":false,"id":"text_msg_updated_at","max":0,"min":0,"name":"updated_at","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}'
}

sync_one_db "$ROOT_DB"
sync_one_db "$PROJ_DB"

echo "PB LC schema sync complete."

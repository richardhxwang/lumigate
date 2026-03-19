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

set_field_max() {
  local db="$1" coll="$2" field_name="$3" maxv="$4"
  local idx
  idx=$(sqlite3 "$db" "select key from _collections c, json_each(c.fields) je where c.name='$coll' and json_extract(je.value, '$.name')='$field_name' limit 1;")
  if [[ -z "$idx" ]]; then
    return 0
  fi
  sqlite3 "$db" "update _collections set fields=json_set(fields, '\$[$idx].max', $maxv), updated=strftime('%Y-%m-%d %H:%M:%fZ') where name='$coll';"
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

  # Lift practical text limits for large AI output / extracted text.
  set_field_max "$db" "lc_files" "extracted_text" 2000000
  set_field_max "$db" "lc_messages" "content" 2000000

  # Backfill existing rows so PB dashboard does not show N/A for historical data.
  sqlite3 "$db" "
    update lc_files
       set original_name = case
         when coalesce(original_name,'')='' then coalesce(file,'')
         else original_name end
     where coalesce(original_name,'')='';

    update lc_files
       set original_name = case
         when coalesce(original_name,'')='' then ('file_' || id)
         else original_name end
     where coalesce(original_name,'')='';

    update lc_files
       set ext = case
         when coalesce(ext,'')<>'' then ext
         when instr(coalesce(original_name,''),'.')>0 then lower(substr(original_name, instr(original_name,'.')))
         else '' end
     where coalesce(ext,'')='';

    update lc_files
       set kind = case
         when coalesce(kind,'')<>'' then kind
         when lower(coalesce(mime_type,'')) like '%pdf%' then 'pdf'
         when lower(coalesce(mime_type,'')) like '%word%' or lower(coalesce(ext,'')) in ('.doc','.docx') then 'document'
         when lower(coalesce(mime_type,'')) like '%spreadsheet%' or lower(coalesce(mime_type,'')) like '%excel%' or lower(coalesce(ext,'')) in ('.xls','.xlsx','.csv') then 'spreadsheet'
         when lower(coalesce(mime_type,'')) like 'image/%' then 'image'
         when lower(coalesce(mime_type,'')) like 'audio/%' then 'audio'
         when lower(coalesce(mime_type,'')) like 'video/%' then 'video'
         else 'file' end
     where coalesce(kind,'')='';

    update lc_files
       set parse_status = case
         when coalesce(parse_status,'')<>'' then parse_status
         when length(coalesce(extracted_text,''))>0 then 'ok'
         else 'empty' end
     where coalesce(parse_status,'')='';

    update lc_files
       set parse_error = coalesce(parse_error,'')
     where parse_error is null;

    update lc_files
       set created_at = case
         when coalesce(created_at,'')<>'' then created_at
         else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
     where coalesce(created_at,'')='';

    update lc_files
       set updated_at = case
         when coalesce(updated_at,'')<>'' then updated_at
         when coalesce(created_at,'')<>'' then created_at
         else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
     where coalesce(updated_at,'')='';

    update lc_files
       set parsed_at = case
         when coalesce(parsed_at,'')<>'' then parsed_at
         when coalesce(parse_status,'') in ('ok','empty','error','not_supported') then coalesce(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         else '' end
     where coalesce(parsed_at,'')='';

    update lc_sessions
       set created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
     where coalesce(created_at,'')='';

    update lc_sessions
       set updated_at = case when coalesce(updated_at,'')<>'' then updated_at else coalesce(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) end
     where coalesce(updated_at,'')='';

    update lc_messages
       set created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
     where coalesce(created_at,'')='';

    update lc_messages
       set updated_at = case when coalesce(updated_at,'')<>'' then updated_at else coalesce(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) end
     where coalesce(updated_at,'')='';
  "

  # Keep future rows non-empty even if some write path misses optional fields.
  sqlite3 "$db" "
    create trigger if not exists lc_files_fill_after_insert
    after insert on lc_files
    begin
      update lc_files
         set original_name = case when coalesce(original_name,'')='' then coalesce(file,'') else original_name end,
             ext = case
               when coalesce(ext,'')<>'' then ext
               when instr(coalesce(original_name,''),'.')>0 then lower(substr(original_name, instr(original_name,'.')))
               else '' end,
             kind = case
               when coalesce(kind,'')<>'' then kind
               when lower(coalesce(mime_type,'')) like '%pdf%' then 'pdf'
               when lower(coalesce(mime_type,'')) like '%word%' or lower(coalesce(ext,'')) in ('.doc','.docx') then 'document'
               when lower(coalesce(mime_type,'')) like '%spreadsheet%' or lower(coalesce(mime_type,'')) like '%excel%' or lower(coalesce(ext,'')) in ('.xls','.xlsx','.csv') then 'spreadsheet'
               when lower(coalesce(mime_type,'')) like 'image/%' then 'image'
               when lower(coalesce(mime_type,'')) like 'audio/%' then 'audio'
               when lower(coalesce(mime_type,'')) like 'video/%' then 'video'
               else 'file' end,
             parse_status = case when coalesce(parse_status,'')<>'' then parse_status when length(coalesce(extracted_text,''))>0 then 'ok' else 'empty' end,
             parse_error = coalesce(parse_error,''),
             created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             updated_at = case when coalesce(updated_at,'')<>'' then updated_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             parsed_at = case
               when coalesce(parsed_at,'')<>'' then parsed_at
               when coalesce(parse_status,'') in ('ok','empty','error','not_supported') then strftime('%Y-%m-%dT%H:%M:%fZ','now')
               else '' end
       where id = new.id;

      update lc_files
         set original_name = case when coalesce(original_name,'')='' then ('file_' || id) else original_name end
       where id = new.id;
    end;

    create trigger if not exists lc_files_fill_after_update
    after update on lc_files
    begin
      update lc_files
         set updated_at = case when coalesce(updated_at,'')<>'' then updated_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             parse_status = case when coalesce(parse_status,'')<>'' then parse_status when length(coalesce(extracted_text,''))>0 then 'ok' else 'empty' end,
             parse_error = coalesce(parse_error,'')
       where id = new.id;
    end;

    create trigger if not exists lc_sessions_fill_after_insert
    after insert on lc_sessions
    begin
      update lc_sessions
         set created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             updated_at = case when coalesce(updated_at,'')<>'' then updated_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
       where id = new.id;
    end;

    create trigger if not exists lc_sessions_fill_after_update
    after update on lc_sessions
    begin
      update lc_sessions
         set updated_at = case when coalesce(updated_at,'')<>'' then updated_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
       where id = new.id;
    end;

    create trigger if not exists lc_messages_fill_after_insert
    after insert on lc_messages
    begin
      update lc_messages
         set created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             updated_at = case when coalesce(updated_at,'')<>'' then updated_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
       where id = new.id;
    end;

    create trigger if not exists lc_messages_fill_after_update
    after update on lc_messages
    begin
      update lc_messages
         set updated_at = case when coalesce(updated_at,'')<>'' then updated_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end,
             created_at = case when coalesce(created_at,'')<>'' then created_at else strftime('%Y-%m-%dT%H:%M:%fZ','now') end
       where id = new.id;
    end;
  "
}

sync_one_db "$ROOT_DB"
sync_one_db "$PROJ_DB"

echo "PB LC schema sync complete."

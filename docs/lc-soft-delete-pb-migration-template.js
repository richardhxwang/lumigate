/// <reference path="../pocketbase/pb_data/types.d.ts" />
migrate((app) => {
  const names = ["lc_projects", "lc_sessions", "lc_messages", "lc_files"];

  for (const name of names) {
    const c = app.findCollectionByNameOrId(name);
    const hasDeletedAt = c.fields.some((f) => f.name === "deleted_at");
    const hasDeletedBy = c.fields.some((f) => f.name === "deleted_by");
    const hasDeleteReason = c.fields.some((f) => f.name === "delete_reason");

    if (!hasDeletedAt) {
      c.fields.add(new Field({
        id: `${name}_deleted_at`,
        name: "deleted_at",
        type: "date",
        required: false,
      }));
    }
    if (!hasDeletedBy) {
      c.fields.add(new Field({
        id: `${name}_deleted_by`,
        name: "deleted_by",
        type: "text",
        required: false,
        max: 64,
      }));
    }
    if (!hasDeleteReason) {
      c.fields.add(new Field({
        id: `${name}_delete_reason`,
        name: "delete_reason",
        type: "text",
        required: false,
        max: 500,
      }));
    }

    app.save(c);
  }
}, (app) => {
  const names = ["lc_projects", "lc_sessions", "lc_messages", "lc_files"];
  for (const name of names) {
    const c = app.findCollectionByNameOrId(name);
    for (const fieldName of ["deleted_at", "deleted_by", "delete_reason"]) {
      const f = c.fields.findByName(fieldName);
      if (f) c.fields.removeById(f.id);
    }
    app.save(c);
  }
});

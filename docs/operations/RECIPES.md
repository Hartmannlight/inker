# Recipe compatibility

Inker keeps the TRMNL device protocol separate from its content model. Existing
devices continue to call `/api/setup`, `/api/display`, and `/api/log`. Those
routes authenticate, select an already prepared publication or compatibility
render, and return the response shape expected by device firmware. They are not
the recipe management API and are not removed by the recipe migration.

## Current support

Inker accepts declarative, local JSON recipe manifests through `POST /api/recipes`.
A manifest contains metadata, four optional Liquid layouts, static partials, a
non-secret settings schema, and an optional required Source connector type.
Literal argument-free `render`/`include` partials are expanded at import time.
Dynamic partial names, layouts, `where_exp`, template I/O, and executable guest
runtimes are rejected.

Each import creates an immutable `RecipeRevision`. A `RecipeBinding` pins exactly
one revision, optional non-secret settings, and an optional `SourceDefinition`.
Provider credentials stay encrypted in `SourceSecret`; only the worker connector
can use them. Rendering reads the latest valid immutable `SourceSnapshot` and
never performs provider I/O. Publishing captures the resulting pixels and source
snapshot reference, so a device delivery does not change when a recipe, binding,
or provider later changes.

This is a safe subset of TRMNL-style Liquid recipes. It is not yet an importer for
the hosted TRMNL recipe catalog or arbitrary upstream YAML repositories. There is
no marketplace, automatic remote update, or Ruby/PHP/Python/Node execution.

## Compatibility migration

On API startup, the idempotent compatibility bridge performs the following:

1. Legacy `DataSource` JSON/RSS configurations become `http-json` or `http-feed`
   SourceDefinitions. Headers are encrypted as a SourceSecret and cached data is
   copied into an immutable SourceSnapshot.
2. Custom widgets are linked to the new SourceDefinition and read snapshots from
   it. Their old foreign key remains temporarily available for rollback and old
   clients.
3. Compatible legacy Plugins become RecipeDefinitions and immutable revisions.
   PluginInstances become bindings; encrypted settings are never copied into the
   recipe settings object.
4. Playlist items gain the recipe binding target while retaining their legacy
   plugin reference during the compatibility period.

An incompatible legacy template is skipped and remains on the legacy path. The
migration does not delete user content.

## Local API flow

Create a definition:

```http
POST /api/recipes
Content-Type: application/json

{
  "protocolVersion": "1.0",
  "slug": "office-status",
  "name": "Office status",
  "source": "local",
  "layouts": {
    "full": "<div class=\"screen\"><h1>{{ title }}</h1></div>"
  },
  "partials": {},
  "settingsSchema": [],
  "requiredConnectorType": "http-json"
}
```

Create a binding to an existing SourceDefinition:

```http
POST /api/recipes/{recipeDefinitionId}/bindings
Content-Type: application/json

{
  "name": "Office display",
  "sourceDefinitionId": "{sourceDefinitionId}",
  "settings": {}
}
```

Use `recipe:{recipeBindingId}` as a playlist target. The normal playlist publish
operation then snapshots the recipe into an immutable publication. Direct legacy
TRMNL pulls can also receive the binding render URL during the compatibility
period.

Appending a revision requires the currently active revision number:

```http
POST /api/recipes/{recipeDefinitionId}/revisions
Content-Type: application/json

{
  "expectedRevision": 1,
  "manifest": { "...": "complete replacement manifest" }
}
```

Bindings do not move to a new revision automatically. Updating a non-legacy
binding requires its current `expectedUpdatedAt`, the selected revision ID, source
ID, and complete settings. This makes upgrades explicit and conflict-safe.

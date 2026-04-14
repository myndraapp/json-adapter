# JSON Adapter Plugin Example

This example demonstrates how to create a JSON adapter plugin that:

1. Detects `.json` file nodes when opened
2. Parses the JSON and creates render-graph nodes representing its structure

## JSON Node Kinds

Per the JSON specification, values are represented as these node kinds:

| Kind           | JSON Type | Example              |
| -------------- | --------- | -------------------- |
| `json:object`  | Object    | `{ "key": "value" }` |
| `json:array`   | Array     | `[1, 2, 3]`          |
| `json:string`  | String    | `"hello"`            |
| `json:number`  | Number    | `42`, `3.14`         |
| `json:boolean` | Boolean   | `true`, `false`      |
| `json:null`    | Null      | `null`               |

## Node Attributes

Each JSON node has these attributes:

- `kind` - One of the `json:*` kinds above
- `label` - Display label (e.g., `"name": "John"`)
- `jsonKey` - The object key (for object properties)
- `jsonIndex` - The array index (for array elements)
- `jsonValue` - The primitive value (for string/number/boolean/null)

## How It Works

### On File Open

When a `.json` file is opened (`file:opened` event):

1. Read the file via `ctx.files.readFile()` and parse with `JSON.parse()`
2. Recursively build render-only nodes and edges (e.g., via a render graph collector)
3. Inject the result into the render graph with `ctx.graph.session.inject()`

## SDK APIs Used

This example requires these SDK APIs:

### GraphAPI (added)

- `getChildren(nodeKey)` - Get child node keys
- `findNodes(predicate)` - Find nodes matching criteria
- `batch(fn)` - Batch multiple operations atomically
- `render` - Render-only graph injection API (draft)

### FileAPI (added)

- `readFile(path)` - Read file contents as string
- `writeFile(path, content)` - Write string content to file
- `exists(path)` - Check if file exists

### Events (added)

- `file:opened` - Fired when a file node is opened
- `file:changed` - Fired when a file changes externally

## Usage

```typescript
import type { MyndraPluginModule, PluginContext } from '@myndra/plugin-sdk'
import { createSessionGraphCollector } from '../shared/sessionGraphCollector'

const plugin: MyndraPluginModule = {
  activate(ctx: PluginContext) {
    // Listen for JSON files being opened
    ctx.events.on('file:opened', async ({ nodeKey, path }) => {
      if (!path.endsWith('.json')) return

      const content = await ctx.files.readFile(path)
      const json = JSON.parse(content)

      const collector = createSessionGraphCollector()
      // Create render-only nodes/edges from JSON...
      ctx.graph.session.inject(collector.getPayload())
    })
  },
}
```

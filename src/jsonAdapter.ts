import {
  getMyndletDefaults,
  getMyndlinkDefaults,
  MyndletAttributesSchema,
  json,
  type Json,
  type Myndlet,
  type MyndletAttributes,
  type FilePosition,
} from '@myndra/plugin-sdk/schemas'
import type { PluginContext, Node, Tree, GraphAPI } from '@myndra/plugin-sdk'
const JSON_KINDS = {
  OBJECT: 'json:object',
  ARRAY: 'json:array',
  STRING: 'json:string',
  NUMBER: 'json:number',
  BOOLEAN: 'json:boolean',
  NULL: 'json:null',
} as const

type JsonKind = (typeof JSON_KINDS)[keyof typeof JSON_KINDS]

const ALL_JSON_KINDS: readonly string[] = Object.values(JSON_KINDS)
const JSON_EXT_NAMESPACE = 'json-adapter'
const JSON_NODE_COLOR = '#4DB6AC'

export const JSON_ADAPTER_ID = 'json-adapter'

const getJsonExtension = (path: string | null | undefined) => {
  if (!path) return null
  const lowered = path.toLowerCase()
  if (lowered.endsWith('.jsonc')) return '.jsonc'
  if (lowered.endsWith('.json')) return '.json'
  return null
}

const isJsonFileNode = (attrs: MyndletAttributes | Partial<MyndletAttributes>) => {
  const { isJsonFile } = getJsonExtFromPartial(attrs)
  return Boolean(isJsonFile || getJsonExtension(attrs.path))
}

type JsonExt = {
  jsonKey?: string
  jsonIndex?: number
  jsonValue?: Json
  isJsonFile?: boolean
  stableId?: string
}

const jsonSchema = json()

const buildJsonNodeAttributes = (
  attrs: Partial<MyndletAttributes>,
  payload: JsonExt,
): MyndletAttributes =>
  MyndletAttributesSchema.parse(
    withJsonExt(
      {
        ...getMyndletDefaults(attrs.kind ?? null),
        ...attrs,
        adapterId: JSON_ADAPTER_ID,
        color: attrs.color ?? JSON_NODE_COLOR,
      },
      payload,
    ),
  )

const hierarchyEdgeDefaults = getMyndlinkDefaults('hierarchy')

const getJsonExt = (attrs: MyndletAttributes): JsonExt => {
  const ext = attrs.ext?.[JSON_EXT_NAMESPACE] as JsonExt | undefined
  return ext ? ext : {}
}

const withJsonExt = (
  attrs: Partial<MyndletAttributes>,
  payload: JsonExt,
): Partial<MyndletAttributes> => {
  const baseExt = { ...(attrs.ext ?? {}) }
  const jsonExt = { ...(baseExt[JSON_EXT_NAMESPACE] ?? {}) }

  if (payload.jsonKey !== undefined) jsonExt.jsonKey = payload.jsonKey
  if (payload.jsonIndex !== undefined) jsonExt.jsonIndex = payload.jsonIndex
  if (payload.jsonValue !== undefined) jsonExt.jsonValue = payload.jsonValue
  if (payload.isJsonFile !== undefined) jsonExt.isJsonFile = payload.isJsonFile
  if (payload.stableId !== undefined) jsonExt.stableId = payload.stableId

  return {
    ...attrs,
    ext: {
      ...baseExt,
      [JSON_EXT_NAMESPACE]: jsonExt,
    },
  }
}

const getJsonKind = (value: unknown): JsonKind => {
  if (value === null) return JSON_KINDS.NULL

  switch (typeof value) {
    case 'object':
      return Array.isArray(value) ? JSON_KINDS.ARRAY : JSON_KINDS.OBJECT
    case 'string':
      return JSON_KINDS.STRING
    case 'number':
      return JSON_KINDS.NUMBER
    case 'boolean':
      return JSON_KINDS.BOOLEAN
    default:
      return JSON_KINDS.NULL
  }
}

const getDisplayLabel = (key: string | number, value: unknown): string => {
  switch (getJsonKind(value)) {
    case JSON_KINDS.OBJECT:
      return `${key}: {…}`
    case JSON_KINDS.ARRAY:
      return `${key}: [${(value as unknown[]).length}]`
    case JSON_KINDS.STRING:
      return `${key}: "${value}"`
    case JSON_KINDS.NUMBER:
    case JSON_KINDS.BOOLEAN:
      return `${key}: ${value}`
    case JSON_KINDS.NULL:
      return `${key}: null`
  }
}

function getJsonExtFromPartial(attrs: Partial<MyndletAttributes> | null | undefined): JsonExt {
  const ext = attrs?.ext?.[JSON_EXT_NAMESPACE]
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {}
  const record = ext as Record<string, unknown>

  const jsonKey = typeof record.jsonKey === 'string' ? record.jsonKey : undefined
  const jsonIndex = typeof record.jsonIndex === 'number' ? record.jsonIndex : undefined
  const isJsonFile = record.isJsonFile === true
  const stableId = typeof record.stableId === 'string' ? record.stableId : undefined

  const jsonValue =
    record.jsonValue === undefined
      ? undefined
      : jsonSchema.safeParse(record.jsonValue).success
        ? (record.jsonValue as Json)
        : undefined

  return { jsonKey, jsonIndex, jsonValue, isJsonFile, stableId }
}

const JSON_SUPPORTED_PARENT_KINDS = [JSON_KINDS.OBJECT, JSON_KINDS.ARRAY] as const

type StructureMoveContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  currentParentKey: string | null
  newParentKey: string
  newParentAttributes: MyndletAttributes
}

type StructureCreateContext = {
  parentKey: string
  parentAttributes: MyndletAttributes
  kind: string
  name: string
  attributes?: Partial<MyndletAttributes>
}

type StructureDeleteContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  parentKey: string | null
}

type StructureRenameContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  currentName: string
  newName: string
}

const createJsonAdapter = (ctx: PluginContext) => ({
  id: 'json-adapter',
  name: 'JSON File Adapter',
  supportedChildKinds: ALL_JSON_KINDS,
  supportedParentKinds: JSON_SUPPORTED_PARENT_KINDS,

  matches(childKind: string | undefined, parentKind: string | undefined) {
    const childMatch = !childKind || ALL_JSON_KINDS.includes(childKind)
    const parentMatch =
      !parentKind || JSON_SUPPORTED_PARENT_KINDS.some((kind) => kind === parentKind)
    return childMatch && parentMatch
  },

  validateMove({
    nodeAttributes,
    newParentAttributes: { kind: parentKind },
  }: StructureMoveContext) {
    const { kind: nodeKind } = nodeAttributes
    const { jsonKey } = getJsonExt(nodeAttributes)

    if (!ALL_JSON_KINDS.includes(nodeKind)) {
      return { valid: false, reason: 'Not a JSON node' }
    }
    if (parentKind === JSON_KINDS.OBJECT) {
      return jsonKey ? { valid: true } : { valid: false, reason: 'Object children must have a key' }
    }

    return parentKind === JSON_KINDS.ARRAY
      ? { valid: true }
      : { valid: false, reason: 'Parent must be an object or array' }
  },

  async applyMove({ nodeKey, newParentKey, currentParentKey }: StructureMoveContext) {
    const rootFileNode = findJsonFileRoot(ctx, nodeKey)
    if (!rootFileNode?.attributes.path) {
      return { success: false, error: 'Could not find JSON file root' }
    }

    try {
      const json = rebuildJsonFromGraph(ctx, rootFileNode.key, {
        nodeKey,
        newParentKey,
        currentParentKey,
      })
      const jsonString = JSON.stringify(json, null, 2)

      try {
        JSON.parse(jsonString)
      } catch (parseError) {
        console.error('[JsonAdapter] Generated invalid JSON', { json, parseError })
        return { success: false, error: 'Internal error: generated invalid JSON' }
      }

      await ctx.files.writeFile(rootFileNode.attributes.path, jsonString)

      // Re-parse and update file positions for accurate preview highlighting
      // Pass pendingMove context so positions are mapped using the new hierarchy
      await updateFilePositionsFromTree(ctx, rootFileNode.key, jsonString, {
        nodeKey,
        newParentKey,
        currentParentKey,
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write JSON',
      }
    }
  },

  validateCreate({ parentAttributes: { kind: parentKind }, kind, name }: StructureCreateContext) {
    if (!ALL_JSON_KINDS.includes(kind)) {
      return { valid: false, reason: `Invalid JSON kind: ${kind}` }
    }

    if (parentKind === JSON_KINDS.OBJECT) {
      return name
        ? { valid: true }
        : { valid: false, reason: 'Object properties must have a key name' }
    }
    return parentKind === JSON_KINDS.ARRAY
      ? { valid: true }
      : { valid: false, reason: 'Can only create inside objects or arrays' }
  },

  async applyCreate({ parentKey, kind, name, attributes }: StructureCreateContext) {
    const incomingExt = getJsonExtFromPartial(attributes)
    const defaultValue = incomingExt.jsonValue ?? getDefaultValueForKind(kind)
    const nodeKey = ctx.graph.durable.addNode(
      buildJsonNodeAttributes(
        {
          kind,
          label: getDisplayLabel(name, defaultValue),
          color: JSON_NODE_COLOR,
          size: 10,
          ...attributes,
        },
        {
          jsonKey: name ?? incomingExt.jsonKey,
          jsonIndex: incomingExt.jsonIndex,
          jsonValue: defaultValue,
        },
      ),
    )

    ctx.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

    const rootFileNode = findJsonFileRoot(ctx, parentKey)
    if (rootFileNode?.attributes.path) {
      try {
        const json = rebuildJsonFromGraph(ctx, rootFileNode.key)
        const jsonString = JSON.stringify(json, null, 2)
        await ctx.files.writeFile(rootFileNode.attributes.path, jsonString)

        // Re-parse and update file positions for accurate preview highlighting
        await updateFilePositionsFromTree(ctx, rootFileNode.key, jsonString)
      } catch (error) {
        ctx.graph.durable.removeNode(nodeKey)
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to write JSON',
        }
      }
    }

    return { success: true, nodeKey }
  },

  validateDelete({ nodeAttributes: { kind } }: StructureDeleteContext) {
    return !ALL_JSON_KINDS.includes(kind)
      ? { valid: false, reason: 'Not a JSON node' }
      : { valid: true }
  },

  async applyDelete({ nodeKey }: StructureDeleteContext) {
    const rootFileNode = findJsonFileRoot(ctx, nodeKey)

    ctx.graph.durable.removeNode(nodeKey)

    if (rootFileNode?.attributes.path) {
      try {
        const json = rebuildJsonFromGraph(ctx, rootFileNode.key)
        const jsonString = JSON.stringify(json, null, 2)
        await ctx.files.writeFile(rootFileNode.attributes.path, jsonString)

        // Re-parse and update file positions for accurate preview highlighting
        await updateFilePositionsFromTree(ctx, rootFileNode.key, jsonString)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to write JSON',
        }
      }
    }

    return { success: true }
  },

  validateRename({ nodeAttributes: { kind }, newName }: StructureRenameContext) {
    if (!ALL_JSON_KINDS.includes(kind)) {
      return { valid: false, reason: 'Not a JSON node' }
    }
    return newName ? { valid: true } : { valid: false, reason: 'Key cannot be empty' }
  },

  async applyRename({ nodeKey, newName }: StructureRenameContext) {
    const node = ctx.graph.getNode(nodeKey)
    if (!node) {
      return { success: false, error: 'Node not found' }
    }

    const { jsonValue } = getJsonExt(node.attributes)
    ctx.graph.durable.updateNode(
      nodeKey,
      withJsonExt(
        { label: getDisplayLabel(newName, jsonValue), ext: node.attributes.ext },
        { jsonKey: newName },
      ),
    )

    const rootFileNode = findJsonFileRoot(ctx, nodeKey)
    if (rootFileNode?.attributes.path) {
      try {
        const json = rebuildJsonFromGraph(ctx, rootFileNode.key)
        const jsonString = JSON.stringify(json, null, 2)
        await ctx.files.writeFile(rootFileNode.attributes.path, jsonString)

        // Re-parse and update file positions for accurate preview highlighting
        await updateFilePositionsFromTree(ctx, rootFileNode.key, jsonString)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to write JSON',
        }
      }
    }

    return { success: true }
  },
})

const getDefaultValueForKind = (kind: string): Json => {
  switch (kind) {
    case JSON_KINDS.OBJECT:
      return {}
    case JSON_KINDS.ARRAY:
      return []
    case JSON_KINDS.STRING:
      return ''
    case JSON_KINDS.NUMBER:
      return 0
    case JSON_KINDS.BOOLEAN:
      return false
    case JSON_KINDS.NULL:
    default:
      return null
  }
}

const findJsonFileRoot = (ctx: PluginContext, nodeKey: string): Myndlet | null => {
  let currentKey: string | null = nodeKey
  while (currentKey) {
    const node = ctx.graph.getNode(currentKey)
    if (!node) return null
    if (isJsonFileNode(node.attributes)) return node
    currentKey = ctx.graph.getParent(currentKey)
  }
  return null
}

const collectSubtreeKeys = (graph: GraphAPI, rootKey: string): string[] => {
  const keys: string[] = []
  const visited = new Set<string>()
  const stack = [rootKey]

  while (stack.length > 0) {
    const key = stack.pop()
    if (!key || visited.has(key)) continue
    visited.add(key)
    keys.push(key)
    const children = graph.getChildren(key)
    for (const child of children) {
      stack.push(child)
    }
  }

  return keys
}

const clearJsonSubtree = (graph: GraphAPI, rootKey: string) => {
  const keys = collectSubtreeKeys(graph, rootKey)
  for (const key of keys) {
    if (key === rootKey) continue
    graph.durable.removeNode(key)
  }
}

/**
 * Context for a pending move operation.
 * Used to rebuild JSON as if the move had already happened.
 */
interface PendingMoveContext {
  nodeKey: string
  newParentKey: string
  currentParentKey: string | null
}

const getChildrenWithPendingMove = (
  ctx: PluginContext,
  parentKey: string,
  pendingMove?: PendingMoveContext,
): string[] => {
  const children = ctx.graph.getChildren(parentKey)

  const sortByPosition = (keys: string[]) =>
    keys.slice().sort((a, b) => {
      const aPos = ctx.graph.getFilePosition(a)
      const bPos = ctx.graph.getFilePosition(b)
      const aIndex =
        typeof aPos?.startIndex === 'number' ? aPos.startIndex : Number.POSITIVE_INFINITY
      const bIndex =
        typeof bPos?.startIndex === 'number' ? bPos.startIndex : Number.POSITIVE_INFINITY
      return aIndex - bIndex
    })

  const orderedChildren = sortByPosition(children)
  if (!pendingMove) {
    return orderedChildren
  }

  const { nodeKey: movingNodeKey, newParentKey, currentParentKey } = pendingMove

  if (parentKey === currentParentKey && parentKey !== newParentKey) {
    return orderedChildren.filter((key) => key !== movingNodeKey)
  }

  if (parentKey === newParentKey) {
    const nextChildren = orderedChildren.filter((key) => key !== movingNodeKey)
    nextChildren.push(movingNodeKey)
    return nextChildren
  }

  if (parentKey === currentParentKey) {
    return orderedChildren.filter((key) => key !== movingNodeKey)
  }

  return orderedChildren
}

const rebuildJsonFromGraph = (
  ctx: PluginContext,
  fileNodeKey: string,
  pendingMove?: PendingMoveContext,
): unknown => {
  const children = getChildrenWithPendingMove(ctx, fileNodeKey, pendingMove)
  if (children.length === 0) return null

  const rootValueKey = children[0]
  return nodeToJson(ctx, rootValueKey, pendingMove)
}

/**
 * After writing JSON to disk, re-parse and update filePosition attributes on all nodes.
 * This ensures the preview panel always has accurate positions for highlighting.
 *
 * Uses pendingMoveContext to correctly map tree-sitter nodes to graph nodes even before
 * the graph hierarchy has been reparented.
 */
const updateFilePositionsFromTree = async (
  ctx: PluginContext,
  fileNodeKey: string,
  jsonContent: string,
  pendingMove?: PendingMoveContext,
): Promise<void> => {
  const tree = await ctx.treeSitter.parse(jsonContent, '.json')
  if (!tree) return

  const children = getChildrenWithPendingMove(ctx, fileNodeKey, pendingMove)
  if (children.length === 0) return

  const rootValueKey = children[0]

  // Find the first value node in the tree (skip document wrapper)
  const findRootValue = (node: Node): Node | null => {
    const kind = treeSitterTypeToJsonKind(node.type)
    if (kind) return node
    for (const child of node.namedChildren) {
      const result = findRootValue(child)
      if (result) return result
    }
    return null
  }

  const rootValueNode = findRootValue(tree.rootNode)
  if (!rootValueNode) return

  // Build a map of all positions to sync
  const positionMap = new Map<string, FilePosition>()

  // Recursively match graph nodes to tree nodes and collect positions
  const collectPositions = (graphNodeKey: string, treeNode: Node) => {
    const graphNode = ctx.graph.getNode(graphNodeKey)
    if (!graphNode) return

    positionMap.set(graphNodeKey, syntaxNodeToFilePosition(treeNode))

    const graphChildren = getChildrenWithPendingMove(ctx, graphNodeKey, pendingMove)
    const kind = treeSitterTypeToJsonKind(treeNode.type)

    if (kind === JSON_KINDS.OBJECT) {
      // Match by jsonKey
      const treeChildMap = new Map<string, Node>()
      for (const child of treeNode.namedChildren) {
        if (child.type === 'pair') {
          const keyNode = child.childForFieldName('key')
          const valueNode = child.childForFieldName('value')
          if (keyNode && valueNode) {
            const key = keyNode.text.slice(1, -1)
            treeChildMap.set(key, valueNode)
          }
        }
      }

      for (const childKey of graphChildren) {
        const childNode = ctx.graph.getNode(childKey)
        if (!childNode) continue
        const { jsonKey } = getJsonExt(childNode.attributes)
        if (jsonKey && treeChildMap.has(jsonKey)) {
          collectPositions(childKey, treeChildMap.get(jsonKey)!)
        }
      }
    } else if (kind === JSON_KINDS.ARRAY) {
      // Match by index
      const treeChildren = treeNode.namedChildren
      graphChildren.forEach((childKey, index) => {
        if (index < treeChildren.length) {
          collectPositions(childKey, treeChildren[index])
        }
      })
    }
  }

  collectPositions(rootValueKey, rootValueNode)

  // Batch update all positions at once
  ctx.graph.batch(() => ctx.graph.derived.syncFilePositions(positionMap))
}

const nodeToJson = (
  ctx: PluginContext,
  nodeKey: string,
  pendingMove?: PendingMoveContext,
): unknown => {
  const node = ctx.graph.getNode(nodeKey)
  if (!node) return null

  const children = getChildrenWithPendingMove(ctx, nodeKey, pendingMove)
  switch (node.attributes.kind) {
    case JSON_KINDS.OBJECT: {
      const obj: Record<string, unknown> = {}
      for (const childKey of children) {
        const child = ctx.graph.getNode(childKey)
        if (!child) continue
        const childExt = getJsonExt(child.attributes)
        if (childExt.jsonKey) {
          obj[childExt.jsonKey] = nodeToJson(ctx, childKey, pendingMove)
        }
      }
      return obj
    }

    case JSON_KINDS.ARRAY: {
      return children.map((childKey: string) => nodeToJson(ctx, childKey, pendingMove))
    }

    case JSON_KINDS.STRING:
    case JSON_KINDS.NUMBER:
    case JSON_KINDS.BOOLEAN:
    case JSON_KINDS.NULL:
      return getJsonExt(node.attributes).jsonValue

    default:
      return null
  }
}

/**
 * Convert a tree-sitter syntax node to file position
 */
const syntaxNodeToFilePosition = (node: Node): FilePosition => ({
  start: { ...node.startPosition },
  end: { ...node.endPosition },
  startIndex: node.startIndex,
  endIndex: node.endIndex,
})

/**
 * Get the JSON kind from a tree-sitter node type
 */
const treeSitterTypeToJsonKind = (type: string): JsonKind | null => {
  switch (type) {
    case 'object':
      return JSON_KINDS.OBJECT
    case 'array':
      return JSON_KINDS.ARRAY
    case 'string':
      return JSON_KINDS.STRING
    case 'number':
      return JSON_KINDS.NUMBER
    case 'true':
    case 'false':
      return JSON_KINDS.BOOLEAN
    case 'null':
      return JSON_KINDS.NULL
    default:
      return null
  }
}

/**
 * Parse a JSON value from a tree-sitter node
 */
const parseJsonValueFromNode = (node: Node): Json => {
  switch (node.type) {
    case 'object': {
      const obj: Record<string, Json> = {}
      for (const child of node.namedChildren) {
        if (child.type === 'pair') {
          const keyNode = child.childForFieldName('key')
          const valueNode = child.childForFieldName('value')
          if (keyNode && valueNode) {
            // Key is a string node, extract the text without quotes
            const key = keyNode.text.slice(1, -1)
            obj[key] = parseJsonValueFromNode(valueNode)
          }
        }
      }
      return obj
    }
    case 'array': {
      return node.namedChildren.map((child: Node) => parseJsonValueFromNode(child))
    }
    case 'string':
      // Remove quotes
      return node.text.slice(1, -1)
    case 'number': {
      const parsed = Number(node.text)
      if (!Number.isFinite(parsed)) {
        console.warn('[JsonAdapter] Skipping invalid JSON number literal', {
          literal: node.text,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
        })
        return null
      }
      return parsed
    }
    case 'true':
      return true
    case 'false':
      return false
    case 'null':
      return null
    default:
      return null
  }
}

const buildJsonStableId = (fileScope: string, node: Node, kind: JsonKind) =>
  `json:${fileScope}:${kind}:${node.startIndex}:${node.endIndex}`

/**
 * Convert a tree-sitter JSON syntax tree to graph nodes
 * Only creates Myndlets for meaningful structures (objects, arrays, and their immediate children)
 */
const treeSitterToGraph = (
  graph: GraphAPI,
  parentKey: string,
  node: Node,
  key: string | number,
  fileScope: string,
): string | null => {
  const kind = treeSitterTypeToJsonKind(node.type)
  if (!kind) {
    // Skip non-value nodes (like 'pair', 'document', etc.)
    // But process their children
    for (const child of node.namedChildren) {
      treeSitterToGraph(graph, parentKey, child, key, fileScope)
    }
    return null
  }

  const value = parseJsonValueFromNode(node)
  if (kind === JSON_KINDS.NUMBER && value === null) {
    return null
  }
  const label = getDisplayLabel(key, value)
  const stableId = buildJsonStableId(fileScope, node, kind)

  const nodeKey = graph.derived.addTreeSitterNode(
    node,
    buildJsonNodeAttributes(
      {
        kind,
        label,
      },
      {
        jsonKey: typeof key === 'string' ? key : undefined,
        jsonIndex: typeof key === 'number' ? key : undefined,
        jsonValue: kind === JSON_KINDS.OBJECT || kind === JSON_KINDS.ARRAY ? undefined : value,
        stableId,
      },
    ),
  )

  graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  if (kind === JSON_KINDS.OBJECT) {
    for (const child of node.namedChildren) {
      if (child.type === 'pair') {
        const keyNode = child.childForFieldName('key')
        const valueNode = child.childForFieldName('value')
        if (keyNode && valueNode) {
          const childKey = keyNode.text.slice(1, -1) // Remove quotes
          treeSitterToGraph(graph, nodeKey, valueNode, childKey, fileScope)
        }
      }
    }
  } else if (kind === JSON_KINDS.ARRAY) {
    node.namedChildren.forEach((child, index) =>
      treeSitterToGraph(graph, nodeKey, child, index, fileScope),
    )
  }

  return nodeKey
}

const buildJsonGraphFromTree = (
  graph: GraphAPI,
  fileNodeKey: string,
  tree: Tree,
  fileScope: string,
) => {
  if (!tree.rootNode) {
    console.error('[JsonAdapter] Missing JSON tree root node', {
      path: fileScope,
      nodeKey: fileNodeKey,
    })
    return
  }
  clearJsonSubtree(graph, fileNodeKey)
  treeSitterToGraph(graph, fileNodeKey, tree.rootNode, 'json:root', fileScope)
}

const parseJsonContent = async (
  ctx: PluginContext,
  nodeKey: string,
  path: string,
  content: string,
  options: { force?: boolean } = {},
): Promise<{ tree: Tree; fileScope: string } | null> => {
  const extension = getJsonExtension(path)
  if (!extension) return null

  if (!options.force) {
    const children = ctx.graph.getChildren(nodeKey)
    if (children.length > 0) {
      return null
    }
  }

  const tree = await ctx.treeSitter.parse(content, extension)
  if (!tree) {
    throw new Error('Tree-sitter JSON grammar not available')
  }

  const fileScope = path.replace(/\\/g, '/')
  return { tree, fileScope }
}

export {
  JSON_KINDS,
  createJsonAdapter,
  isJsonFileNode,
  parseJsonContent,
  buildJsonGraphFromTree,
  clearJsonSubtree,
}

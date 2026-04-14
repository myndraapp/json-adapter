import type { MyndraPluginModule, Tree, AdapterMutationResult } from '@myndra/plugin-sdk'
import { json as jsonSyntax } from '@codemirror/lang-json'
import {
  JSON_KINDS,
  isJsonFileNode,
  parseJsonContent,
  buildJsonGraphFromTree,
  createJsonAdapter,
  JSON_ADAPTER_ID,
} from './jsonAdapter'
import {
  createSessionGraphCollector,
  type SessionGraphPayload,
} from '@myndra/plugin-sdk/helpers'

const normalizePath = (input: string) => input.replace(/\\/g, '/')

let unregisterPreview: (() => void) | null = null

const JSON_EXTENSIONS = ['.json', '.jsonc']

const mergeRenderPayloads = (payloads: Iterable<SessionGraphPayload>): SessionGraphPayload => {
  const nodes = new Map<string, SessionGraphPayload['nodes'][number]>()
  const edges = new Map<string, SessionGraphPayload['edges'][number]>()

  for (const payload of payloads) {
    for (const node of payload.nodes) nodes.set(node.key, node)
    for (const edge of payload.edges) edges.set(edge.key, edge)
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  }
}

const plugin: MyndraPluginModule = {
  extensions: () => JSON_EXTENSIONS,
  async activate(ctx) {
    JSON_EXTENSIONS.forEach((extension) => ctx.editor.registerExtensions(extension, [jsonSyntax()]))

    ctx.filePreview.registerAdapter({
      extensions: JSON_EXTENSIONS,
      buildDraftPayload: async ({ nodeKey, filePath, content }) => {
        const extension = filePath.toLowerCase().endsWith('.jsonc') ? '.jsonc' : '.json'
        const tree = await ctx.treeSitter.parse(content, extension)
        if (!tree) return null
        const collector = createSessionGraphCollector()
        buildJsonGraphFromTree(collector.graph, nodeKey, tree, normalizePath(filePath))
        return collector.getPayload()
      },
    })
    unregisterPreview = () => ctx.filePreview.unregisterAdapter()

    ctx.glyphs.register(JSON_KINDS.OBJECT, ctx.resolveAsset('data_object.png'))
    ctx.glyphs.register(JSON_KINDS.ARRAY, ctx.resolveAsset('data_array.png'))
    ctx.glyphs.register(JSON_KINDS.STRING, ctx.resolveAsset('abc.png'))
    ctx.glyphs.register(JSON_KINDS.NUMBER, ctx.resolveAsset('123.png'))
    ctx.glyphs.register(JSON_KINDS.BOOLEAN, ctx.resolveAsset('select_check_box.png'))
    ctx.glyphs.register(JSON_KINDS.NULL, ctx.resolveAsset('deselect.png'))
    const jsonStructureAdapter = createJsonAdapter(ctx)

    ctx.hierarchy.registerAdapter({
      id: JSON_ADAPTER_ID,
      name: 'JSON Structure Adapter',
      supportedChildKinds: Object.values(JSON_KINDS),
      supportedParentKinds: [JSON_KINDS.OBJECT, JSON_KINDS.ARRAY],

      handlers: {
        async onMove(moveCtx): Promise<AdapterMutationResult> {
          const node = ctx.graph.getNode(moveCtx.nodeKey)
          const newParent = ctx.graph.getNode(moveCtx.newParentKey)
          if (!node || !newParent) {
            return { success: false, error: 'Node or parent not found' }
          }

          const validation = jsonStructureAdapter.validateMove({
            nodeKey: moveCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentParentKey: moveCtx.currentParentKey,
            newParentKey: moveCtx.newParentKey,
            newParentAttributes: newParent.attributes,
          })

          if (!validation.valid) {
            return { success: false, error: validation.reason }
          }

          const result = await jsonStructureAdapter.applyMove({
            nodeKey: moveCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentParentKey: moveCtx.currentParentKey,
            newParentKey: moveCtx.newParentKey,
            newParentAttributes: newParent.attributes,
          })

          // File watcher will trigger re-render after file is written
          return {
            success: result.success,
            error: result.error,
          }
        },

        async onDelete(deleteCtx): Promise<AdapterMutationResult> {
          const node = ctx.graph.getNode(deleteCtx.nodeKey)
          if (!node) {
            return { success: false, error: 'Node not found' }
          }

          const parentKey = ctx.graph.getParent(deleteCtx.nodeKey)
          const validation = jsonStructureAdapter.validateDelete({
            nodeKey: deleteCtx.nodeKey,
            nodeAttributes: node.attributes,
            parentKey,
          })

          if (!validation.valid) {
            return { success: false, error: validation.reason }
          }

          const result = await jsonStructureAdapter.applyDelete({
            nodeKey: deleteCtx.nodeKey,
            nodeAttributes: node.attributes,
            parentKey,
          })

          // File watcher will trigger re-render after file is written
          return {
            success: result.success,
            error: result.error,
          }
        },

        async onRename(renameCtx): Promise<AdapterMutationResult> {
          const node = ctx.graph.getNode(renameCtx.nodeKey)
          if (!node) {
            return { success: false, error: 'Node not found' }
          }

          const validation = jsonStructureAdapter.validateRename({
            nodeKey: renameCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentName: renameCtx.currentLabel,
            newName: renameCtx.newLabel,
          })

          if (!validation.valid) {
            return { success: false, error: validation.reason }
          }

          const result = await jsonStructureAdapter.applyRename({
            nodeKey: renameCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentName: renameCtx.currentLabel,
            newName: renameCtx.newLabel,
          })

          // File watcher will trigger re-render after file is written
          return {
            success: result.success,
            error: result.error,
          }
        },
      },
    })

    const openFilesBySession = new Map<string, string>()
    const renderPayloadsByFile = new Map<string, SessionGraphPayload>()
    let scopeRequestId = 0

    const buildRenderPayload = (nodeKey: string, tree: Tree, fileScope: string) => {
      const collector = createSessionGraphCollector()
      buildJsonGraphFromTree(collector.graph, nodeKey, tree, fileScope)
      return collector.getPayload()
    }

    const injectSessionPayload = (sessionId: string | undefined, nodeKey: string) => {
      const payload = renderPayloadsByFile.get(nodeKey)
      if (!payload) {
        if (sessionId) ctx.graph.session.clear(sessionId)
        else ctx.graph.session.clear()
        return
      }
      ctx.graph.session.inject({
        sessionId,
        nodes: payload.nodes,
        edges: payload.edges,
      })
    }

    const parseJsonEntries = async (
      entries: Array<{ nodeKey: string; path: string; force: boolean }>,
      requestId?: number,
    ) => {
      if (!entries.length) return
      const readResults = await ctx.files.readFiles(entries.map((entry) => entry.path))

      for (let index = 0; index < entries.length; index += 1) {
        if (requestId !== undefined && requestId !== scopeRequestId) {
          return
        }
        const entry = entries[index]
        const readResult = readResults[index]
        if (!readResult || readResult.content === null) {
          console.error('[JsonAdapter] Failed to read JSON', {
            path: entry.path,
            error: readResult?.error,
          })
          renderPayloadsByFile.delete(entry.nodeKey)
          continue
        }

        try {
          const result = await parseJsonContent(
            ctx,
            entry.nodeKey,
            entry.path,
            readResult.content,
            { force: entry.force },
          )
          if (result) {
            renderPayloadsByFile.set(
              entry.nodeKey,
              buildRenderPayload(entry.nodeKey, result.tree, result.fileScope),
            )
          } else {
            renderPayloadsByFile.delete(entry.nodeKey)
          }
        } catch (error) {
          console.error('[JsonAdapter] Failed to parse JSON', {
            path: entry.path,
            nodeKey: entry.nodeKey,
            error,
          })
          renderPayloadsByFile.delete(entry.nodeKey)
        }
      }
    }

    const setSessionOpenFile = (sessionId: string | undefined, nodeKey: string | null) => {
      if (!sessionId) return
      const previous = openFilesBySession.get(sessionId)
      if (previous && previous !== nodeKey) {
        ctx.graph.session.clear(sessionId)
      }
      if (nodeKey) {
        openFilesBySession.set(sessionId, nodeKey)
      } else {
        openFilesBySession.delete(sessionId)
      }
    }

    const enableFullScope = async () => {
      const requestId = ++scopeRequestId

      const entries = ctx.graph
        .findNodes(({ attributes }) => isJsonFileNode(attributes))
        .map((node) => ({
          nodeKey: node.key,
          path: node.attributes.path,
        }))
        .filter((entry): entry is { nodeKey: string; path: string } => Boolean(entry.path))
        .map((entry) => ({ nodeKey: entry.nodeKey, path: entry.path, force: true }))

      await parseJsonEntries(entries, requestId)
      if (requestId !== scopeRequestId) return

      const merged = mergeRenderPayloads(renderPayloadsByFile.values())
      ctx.graph.session.inject({ nodes: merged.nodes, edges: merged.edges })
    }

    const disableFullScope = () => {
      scopeRequestId += 1
      ctx.graph.session.clear()
    }

    ctx.events.on('graph:plugin-scope', async ({ pluginId, scope }) => {
      if (pluginId !== ctx.manifest.name) return
      if (scope === 'full') {
        await enableFullScope()
      } else {
        disableFullScope()
      }
    })

    ctx.events.on('file:opened', async ({ nodeKey, path, sessionId }) => {
      setSessionOpenFile(sessionId, nodeKey)
      await parseJsonEntries([{ nodeKey, path, force: true }])
      injectSessionPayload(sessionId, nodeKey)
    })

    ctx.events.on('file:closed', ({ nodeKey, sessionId }) => {
      if (!sessionId) {
        ctx.graph.session.clear()
        return
      }
      const previous = openFilesBySession.get(sessionId)
      if (previous !== nodeKey) return
      ctx.graph.session.clear(sessionId)
      openFilesBySession.delete(sessionId)
    })

    ctx.events.on('file:changed', async ({ nodeKey, path }) => {
      await parseJsonEntries([{ nodeKey, path, force: true }])

      for (const [sessionId, openNodeKey] of openFilesBySession.entries()) {
        if (openNodeKey === nodeKey) {
          injectSessionPayload(sessionId, nodeKey)
        }
      }
    })
  },

  deactivate() {
    if (!unregisterPreview) return
    unregisterPreview()
    unregisterPreview = null
  },
}

export default plugin

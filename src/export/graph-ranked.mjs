import { exportCapability } from './capabilities.mjs';
import { openSink, formatRows, DATASET_FORMATS, ExportError } from './export.mjs';

export async function exportGraphRanked(session, outFile, { format = 'json', limit = 100, seeds = [] } = {}) {
  if (!DATASET_FORMATS.includes(format)) throw new ExportError(`Unknown ranked graph format ${format}.`, 'BAD_FORMAT');
  if (!Number.isInteger(limit) || limit < 1) throw new ExportError('Ranked graph limit must be a positive integer.', 'BAD_FORMAT');
  const rankGraphNodes = await exportCapability('../intel/graph.mjs', 'rankGraphNodes', 'Graph ranking');
  const graph = session.kv.get('GRAPH', null);
  if (!graph) throw new ExportError(`No graph for ${session.id}. Run "studio derive ${session.id}" first.`, 'NO_KNOWLEDGE');
  const nodes = new Map((graph.nodes ?? []).map((node) => [node.eid ?? node.id, node]));
  const ranked = await rankGraphNodes(graph, { seeds });
  const rows = ranked.slice(0, limit).map((item, index) => ({ rank: index + 1, ...nodes.get(item.eid), ...item }));
  const text = format === 'json' ? JSON.stringify({ session: session.id, algorithm: 'confidence-weighted-pagerank', seeds, total: ranked.length, rows }, null, 2) + '\n'
    : await formatRows(rows, format, { title: `Ranked graph ${session.id}` });
  const sink = openSink(outFile);
  await sink.write(text); await sink.end();
  return { file: sink.path, format, bytes: Buffer.byteLength(text), nodes: rows.length, total: ranked.length };
}

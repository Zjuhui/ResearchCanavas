import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, getSmoothStepPath, useReactFlow, useUpdateNodeInternals, type Connection, type EdgeProps, type Node, type NodeProps, type NodePositionChange, type OnNodesChange, type Edge } from '@xyflow/react';
import { attachFile, createExampleProject, createProject, nodeDepth, removeNode, removePort, validateProject } from './shared/model';
import type { CodeFile, DesignEdge, DesignNode, FileRef, Port, PortBinding, Project, TaskKind } from './shared/types';

type Selection = { kind: 'node' | 'edge' | 'file'; id: string } | null;
type CanvasData = { name: string; description: string; inputs: Port[]; outputs: Port[]; depth: number; childNames: string[]; expanded: boolean; width?: number; height?: number; onEnter: () => void; onExpand: () => void };
type BoundaryData = { moduleId: string; name: string; direction: 'input' | 'output'; ports: Port[]; onBind: () => void };
type FileData = { name: string; description: string; count: number; onOpen: () => void };
type Task = { id: string; status: 'starting' | 'running' | 'needs-approval' | 'completed' | 'failed' | 'cancelled'; kind: TaskKind; threadId?: string; output: string; error?: string; context?:{nodeId:string;nodeName:string;projectId:string;revision:number}; approvals: { id: string | number; method: string; params: unknown }[] };
type Health = { codex: { available: boolean; version?: string }; vscodeAvailable: boolean };
type EdgeDraft = { graphId: string | null; source: string; target: string; sourcePort: string | null; targetPort: string | null; relation: string; loop: boolean; loopNote: string };
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const boundaryId = (moduleId: string, direction: 'input' | 'output') => `__boundary-${direction}-${moduleId}`;
const moduleHeight = (node: DesignNode) => 206 + Math.max(node.inputs.length, node.outputs.length, 1) * 29;
function expandedLayout(project: Project, module: DesignNode) {
  const children = project.nodes.filter(node => node.parentId === module.id);
  const minX = children.length ? Math.min(...children.map(node => node.position.x)) : 0;
  const minY = children.length ? Math.min(...children.map(node => node.position.y)) : 0;
  const header = moduleHeight(module) + 45;
  const inputLanes = project.bindings.filter(b => b.moduleId === module.id && b.direction === 'input').length;
  const outputLanes = project.bindings.filter(b => b.moduleId === module.id && b.direction === 'output').length;
  const offset = { x: 250 - minX, y: header + Math.max(75, inputLanes * 37 + 38) - minY };
  const right = Math.max(570, ...children.map(node => node.position.x + offset.x + 264));
  const bottom = Math.max(header + 370, ...children.map(node => node.position.y + offset.y + moduleHeight(node)));
  return { offset, header, width: right + 250, height: bottom + Math.max(65, outputLanes * 37 + 26), outputX: right + 40 };
}
const taskNames: Record<TaskKind, string> = { research: '调研', plan: '比较方案', implement: '实现代码' };
const flowColors = { connection: '#738099', selected: '#6554d4', loop: '#9b713a', binding: '#557b94' };
const taskStatus: Record<Task['status'], string> = { starting: '正在连接', running: '正在执行', 'needs-approval': '等待批准', completed: '已完成', failed: '执行失败', cancelled: '已取消' };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}
function Glyph({ name, size = 18 }: { name: 'plus' | 'arrow' | 'file' | 'layers' | 'undo' | 'link' | 'spark' | 'save' | 'close'; size?: number }) {
  const paths = { plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', file: 'M14 3H5v18h14V8l-5-5v5h5', layers: 'm12 3 10 6-10 6L2 9l10-6Zm-9 11 9 6 9-6M3 18l9 5 9-5', undo: 'M9 6 3 11l6 5M3 11h11a6 6 0 0 1 0 12', link: 'm9 15 6-6M7 14l-2 2a4 4 0 0 0 6 6l3-3M10 5l3-3a4 4 0 0 1 6 6l-2 2', spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z', save: 'M5 3h12l4 4v14H3V3h2Zm2 0v7h10V3M7 21v-8h10v8', close: 'm6 6 12 12M6 18 18 6' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function ModuleCard({ id, data, selected }: NodeProps<Node<CanvasData>>) {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(id); }, [id, data.inputs, data.outputs, data.expanded, updateInternals]);
  const group = data.expanded && data.depth === 1;
  return <div className={`module-card ${selected ? 'is-selected' : ''} ${group ? 'expanded-module' : ''}`} style={group ? { width: data.width, height: data.height } : undefined}>
    {data.inputs.length > 0 && <Handle type="target" position={Position.Left} id="__default-in" style={{ opacity: 0 }} />}
    {data.outputs.length > 0 && <Handle type="source" position={Position.Right} id="__default-out" style={{ opacity: 0 }} />}
    <div className="node-eyebrow"><span className="node-icon"><Glyph name="layers" size={15} /></span>{data.depth === 1 ? '模块' : '功能'}<span className="node-count">{data.childNames.length} {data.depth === 1 ? '个功能' : '个文件'}</span></div>
    <h3>{data.name}</h3><p className="node-description">{data.description || '点击填写设计说明'}</p>
    <div className="ports-row"><div>{data.inputs.map(port => <div key={port.id} className="node-port input-port"><Handle type="target" position={Position.Left} id={port.id} /><span>{port.name}</span></div>)}{!data.inputs.length && <div className="node-port input-port muted"><Handle type="target" position={Position.Left} id="__default-in" /><span>输入待定义</span></div>}</div><div>{data.outputs.map(port => <div key={port.id} className="node-port output-port"><span>{port.name}</span><Handle type="source" position={Position.Right} id={port.id} /></div>)}{!data.outputs.length && <div className="node-port output-port muted"><span>输出待定义</span><Handle type="source" position={Position.Right} id="__default-out" /></div>}</div></div>
    {data.expanded && data.depth === 2 && <div className="inner-preview">{data.childNames.length ? data.childNames.map((name, i) => <span key={i}><Glyph name="file" size={12} />{name}</span>) : <span className="muted">尚未关联文件</span>}</div>}
    <div className="node-actions nodrag"><button onClick={data.onExpand}>{data.depth === 1 ? data.expanded ? '收起内部画布' : '展开内部画布' : data.expanded ? '收起文件列表' : '查看文件列表'}</button><button onClick={data.onEnter}>{data.depth === 1 ? '进入功能画布' : '进入文件映射'}<Glyph name="arrow" size={13} /></button></div>
    {group && <div className="expanded-canvas-caption">内部功能与接口绑定 · 点击节点或连线编辑{!data.childNames.length && <span>内部画布为空，进入后添加功能。</span>}</div>}
  </div>;
}
function BoundaryCard({ id, data }: NodeProps<Node<BoundaryData>>) {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(id); }, [id, data.ports, updateInternals]);
  return <div className={`boundary-card boundary-${data.direction}`}><div className="boundary-card-heading">{data.direction === 'input' ? '模块输入' : '模块输出'}</div><strong>{data.name}</strong>{data.ports.map(port => <div className="boundary-port" key={port.id} title={port.description}><span>{port.name}</span><Handle type={data.direction === 'input' ? 'source' : 'target'} position={data.direction === 'input' ? Position.Right : Position.Left} id={port.id} /></div>)}{!data.ports.length && <p>先在模块属性中添加端口</p>}<button className="nodrag" onClick={data.onBind}>编辑接口绑定</button></div>;
}
function FileCard({ data, selected }: NodeProps<Node<FileData>>) {
  return <div className={`file-card ${selected ? 'is-selected' : ''}`}><div className="node-eyebrow"><span className="file-icon"><Glyph name="file" size={17} /></span>代码文件<span className="shared-count">{data.count > 1 ? `${data.count} 个功能共享` : '功能引用'}</span></div><h3>{data.name}</h3><p>{data.description || '点击编辑文件说明和引用备注'}</p><button className="file-open nodrag" onClick={data.onOpen}>在 VS Code 中打开<Glyph name="arrow" size={13} /></button></div>;
}
function RelationEdge(props: EdgeProps) {
  const selfLoop = props.source === props.target;
  const loop = selfLoop || props.data?.isLoop === true;
  const [normalPath, normalX, normalY] = getSmoothStepPath({ ...props, borderRadius: 14, offset: 30 });
  const loopTop = typeof props.data?.loopTop === 'number' ? props.data.loopTop : Math.min(props.sourceY, props.targetY) - 180;
  const routeY = typeof props.data?.routeY === 'number' ? props.data.routeY : undefined;
  const path = selfLoop ? `M ${props.sourceX},${props.sourceY} C ${props.sourceX + 90},${props.sourceY} ${props.sourceX + 90},${loopTop} ${props.sourceX},${loopTop} L ${props.targetX},${loopTop} C ${props.targetX - 90},${loopTop} ${props.targetX - 90},${props.targetY} ${props.targetX},${props.targetY}` : loop ? `M ${props.sourceX},${props.sourceY} L ${props.sourceX + 18},${props.sourceY} L ${props.sourceX + 18},${loopTop} L ${props.targetX - 18},${loopTop} L ${props.targetX - 18},${props.targetY} L ${props.targetX},${props.targetY}` : routeY === undefined ? normalPath : `M ${props.sourceX},${props.sourceY} L ${props.sourceX + 22},${props.sourceY} L ${props.sourceX + 22},${routeY} L ${props.targetX - 22},${routeY} L ${props.targetX - 22},${props.targetY} L ${props.targetX},${props.targetY}`;
  const x = loop || routeY !== undefined ? (props.sourceX + props.targetX) / 2 : normalX;
  const y = loop ? loopTop : routeY ?? normalY;
  return <><BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={22} /><EdgeLabelRenderer><button className={`edge-label edge-caption nodrag nopan ${props.selected ? 'is-selected' : ''} ${routeY !== undefined ? 'binding-label' : ''}`} data-edge-id={props.id} style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, pointerEvents: 'all' }} title={String(props.label || '连接规则待说明')} onClick={event => { event.stopPropagation(); if (typeof props.data?.onSelect === 'function') props.data.onSelect(); }}>{String(props.label || '连接规则待说明').slice(0, 18)}{String(props.label || '').length > 18 ? '…' : ''}</button></EdgeLabelRenderer></>;
}
const nodeTypes = { module: ModuleCard, codeFile: FileCard, boundary: BoundaryCard };
const edgeTypes = { relation: RelationEdge };
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  const id = useId();
  return <label className="field"><span id={id}>{label}</span>{Children.map(children, child => isValidElement(child) && typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type) ? cloneElement(child as React.ReactElement<{ 'aria-labelledby'?: string }>, { 'aria-labelledby': id }) : child)}{hint && <small>{hint}</small>}</label>;
}
function AppBody() {
  const [project, setProject] = useState<Project | null>(null);
  const current = useRef<Project | null>(null);
  const revision = useRef(0);
  const saved = useRef('');
  const history = useRef<Project[]>([]);
  const [, rerender] = useState(0);
  const [workspace, setWorkspace] = useState('');
  const [graphId, setGraphId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<'design' | 'research' | 'proposals'>('design');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<EdgeDraft | null>(null);
  const [bindingDraft, setBindingDraft] = useState<PortBinding | null>(null);
  const [fileDialog, setFileDialog] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [taskDialog, setTaskDialog] = useState(false);
  const [taskKind, setTaskKind] = useState<TaskKind>('research');
  const [instruction, setInstruction] = useState('');
  const [prompt, setPrompt] = useState('');
  const [promptKey, setPromptKey] = useState('');
  const [promptRevision, setPromptRevision] = useState<number | null>(null);
  const previewRequest = useRef(0);
  const taskContextRef = useRef('');
  const [task, setTask] = useState<Task | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [saving, setSaving] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const canvasContainer = useRef<HTMLElement>(null);
  const { fitView, getNodesBounds, screenToFlowPosition, setCenter } = useReactFlow();
  const dirty = project !== null && JSON.stringify(project) !== saved.current;
  const graphNode = project?.nodes.find(n => n.id === graphId);
  const fileLayer = Boolean(graphNode && graphNode.parentId !== null);
  const canvasLevel = fileLayer ? 3 : graphId ? 2 : 1;
  const selectedNode = selection?.kind === 'node' ? project?.nodes.find(n => n.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === 'edge' ? project?.edges.find(e => e.id === selection.id) : undefined;
  const selectedRef = selection?.kind === 'file' ? project?.fileRefs.find(r => r.id === selection.id) : undefined;
  const selectedFile = project?.files.find(f => f.id === selectedRef?.fileId);
  const contextNode = selectedNode || graphNode;
  const taskContextKey = JSON.stringify([contextNode?.id, taskKind, instruction, revision.current, dirty]);
  taskContextRef.current = taskContextKey;
  const fail = useCallback((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); }, []);
  const replace = useCallback((next: Project) => { current.current = next; setProject(next); }, []);
  const edit = useCallback((update: (p: Project) => Project, remember = true) => {
    const previous = current.current;
    if (!previous) return;
    let next:Project;
    try { next = update(previous); } catch(error) { fail(error);return; }
    if (next === previous || JSON.stringify(next) === JSON.stringify(previous)) return;
    if (remember) { history.current.push(previous); if (history.current.length > 80) history.current.shift(); }
    replace(next); setNotice('');
  }, [replace, fail]);
  const updateNode = (id: string, patch: Partial<DesignNode>) => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === id ? { ...n, ...patch } : n) }));
  const updateEdge = (id: string, patch: Partial<DesignEdge>) => edit(p => ({ ...p, edges: p.edges.map(e => e.id === id ? { ...e, ...patch } : e) }));
  const updateFile = (id: string, patch: Partial<CodeFile>) => edit(p => ({ ...p, files: p.files.map(f => f.id === id ? { ...f, ...patch } : f) }));
  const updateRef = (id: string, patch: Partial<FileRef>) => edit(p => ({ ...p, fileRefs: p.fileRefs.map(r => r.id === id ? { ...r, ...patch } : r) }));
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try { const data = await api<{ project: Project; workspaceRoot: string }>('/api/project'); const next = validateProject(data.project); revision.current = next.revision; saved.current = JSON.stringify(next); history.current = []; replace(next); setWorkspace(data.workspaceRoot); setGraphId(null); setSelection(null); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }, [fail, replace]);
  useEffect(() => { void load(); void api<Health>('/api/health').then(setHealth).catch(fail); void api<{ tasks: Task[] }>('/api/tasks').then(data => { if (data.tasks[0]) setTask(data.tasks[0]); }).catch(fail); }, [load, fail]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (current.current && JSON.stringify(current.current) !== saved.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, []);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 760px)');
    const update = (event: MediaQueryListEvent) => setInspectorOpen(!event.matches);
    narrow.addEventListener('change', update);
    return () => narrow.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (!project || dirty) return; void api('/api/selection', { method: 'POST', body: JSON.stringify({ nodeId: contextNode?.id || null }) }).catch(fail); }, [contextNode?.id, project?.id, dirty, fail]);
  useEffect(() => { if (!task || !['starting', 'running', 'needs-approval'].includes(task.status)) return; const timer = setInterval(() => { void api<{ task: Task }>(`/api/tasks/${task.id}`).then(data => setTask(data.task)).catch(fail); }, 1500); return () => clearInterval(timer); }, [task?.id, task?.status, fail]);
  useEffect(() => { setPrompt(''); setPromptKey(''); setPromptRevision(null);previewRequest.current += 1; }, [taskContextKey]);
  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => { void fitView({ padding: 0.08, maxZoom: 1 }); }, 100);
    return () => clearTimeout(timer);
  }, [project?.id, graphId, fitView]);
  useEffect(() => {
    const element = canvasContainer.current;
    if (!element) return;
    let width = element.clientWidth;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || Math.abs(entry.contentRect.width - width) < 2) return;
      width = entry.contentRect.width;
      clearTimeout(timer);
      timer = setTimeout(() => { void fitView({ padding: 0.3, maxZoom: 1 }); }, 80);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [Boolean(project), fitView]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setEdgeDraft(null); setBindingDraft(null); setFileDialog(false); setTaskDialog(false); } }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, []);
  const enter = useCallback((id: string | null) => { setGraphId(id); setSelection(null); setTab('design'); requestAnimationFrame(() => { void fitView({ padding: 0.2, duration: 200, maxZoom: 1 }); }); }, [fitView]);
  const focusNode = (id: string) => {
    if (expanded.includes(id)) return;
    const bounds = getNodesBounds([id]);
    if (bounds.width > 0 && bounds.height > 0) void setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom: 1, duration: 220 });
  };
  const save = async () => {
    const submitted = current.current; if (!submitted) return;
    setSaving(true); setError('');
    try { const result = await api<{ project: Project }>('/api/project', { method: 'PUT', body: JSON.stringify({ project: submitted, expectedRevision: revision.current }) }); revision.current = result.project.revision; saved.current = JSON.stringify(result.project); if (JSON.stringify(current.current) === JSON.stringify(submitted)) replace(result.project); else if (current.current) replace({ ...current.current, revision: result.project.revision, updatedAt: result.project.updatedAt }); setNotice('已保存到项目目录'); }
    catch (e) { fail(e); } finally { setSaving(false); }
  };
  const undo = () => { const previous = history.current.pop(); if (previous) { replace(previous); if (graphId && !previous.nodes.some(n => n.id === graphId)) setGraphId(null); setSelection(null); setNotice('已撤销上一步'); } };
  const addNode = () => {
    const siblings = project?.nodes.filter(n => n.parentId === graphId) || [];
    const center = screenToFlowPosition({ x: Math.max(180, window.innerWidth * 0.4), y: 280 });
    const position = siblings.length ? { x: Math.min(...siblings.map(n => n.position.x)) + siblings.length % 3 * 350, y: Math.min(...siblings.map(n => n.position.y)) + Math.floor(siblings.length / 3) * 340 } : center;
    const node: DesignNode = { id: uid('node'), parentId: graphId, name: `${graphId ? '新功能' : '新模块'} ${siblings.length + 1}`, description: '', position, inputs: [], outputs: [], branchRule: '' };
    edit(p => ({ ...p, nodes: [...p.nodes, node] })); setSelection({ kind: 'node', id: node.id }); setTab('design'); setInspectorOpen(true);
  };
  const openCode = async (fileId: string) => { if (dirty) { setError('请先保存项目，再打开已保存的文件映射。'); return; } try { await api('/api/open-file', { method: 'POST', body: JSON.stringify({ fileId }) }); setNotice('已请求 VS Code 打开文件'); } catch (e) { fail(e); } };
  const addBinding = (moduleId: string, direction: 'input' | 'output' = 'input', patch: Partial<PortBinding> = {}) => {
    const module = project?.nodes.find(n => n.id === moduleId);
    const child = project?.nodes.find(n => n.parentId === moduleId && (direction === 'input' ? n.inputs : n.outputs).length > 0) || project?.nodes.find(n => n.parentId === moduleId);
    setBindingDraft({ id: uid('binding'), moduleId, direction, modulePortId: (direction === 'input' ? module?.inputs : module?.outputs)?.[0]?.id || '', childNodeId: child?.id || '', childPortId: (direction === 'input' ? child?.inputs : child?.outputs)?.[0]?.id || '', description: '', ...patch });
  };
  const commitBinding = () => {
    if (!bindingDraft) return;
    try { const next = validateProject({ ...project, bindings: [...(project?.bindings || []).filter(b => b.id !== bindingDraft.id), bindingDraft] }); edit(() => next); setBindingDraft(null); setNotice('已记录接口绑定；自然语言说明仍需在实现时澄清。'); } catch (e) { fail(e); }
  };
  // Expansion changes the view only. Keep these offsets stable while the user drags
  // an outer node, then subtract them before storing its authored coordinates.
  const rootLayoutKey = JSON.stringify([project?.id, expanded, project?.nodes.map(n => [n.id, n.parentId, n.inputs.length, n.outputs.length, n.parentId === null ? null : n.position]), project?.bindings]);
  const rootOffsets = useMemo(() => {
    const offsets = new Map<string, { x: number; y: number }>();
    const placed: { x: number; y: number; width: number; height: number }[] = [];
    const roots = project?.nodes.filter(n => n.parentId === null).sort((a, b) => Number(expanded.includes(b.id)) - Number(expanded.includes(a.id)) || a.position.y - b.position.y || a.position.x - b.position.x) || [];
    for (const root of roots) {
      const layout = expanded.includes(root.id) && project ? expandedLayout(project, root) : undefined;
      const rect = { ...root.position, width: layout?.width || 264, height: layout?.height || moduleHeight(root) };
      if (expanded.length) {
        let overlap;
        do { overlap = placed.find(other => rect.x < other.x + other.width + 60 && rect.x + rect.width + 60 > other.x && rect.y < other.y + other.height + 60 && rect.y + rect.height + 60 > other.y); if (overlap) rect.x = overlap.x + overlap.width + 80; } while (overlap);
      }
      offsets.set(root.id, { x: rect.x - root.position.x, y: rect.y - root.position.y });
      placed.push(rect);
    }
    return offsets;
  }, [rootLayoutKey]);
  const canvasNodes: Node[] = useMemo(() => {
    if (!project) return [];
    if (fileLayer) return project.fileRefs.filter(ref => ref.nodeId === graphId).flatMap(ref => { const file = project.files.find(f => f.id === ref.fileId); return file ? [{ id: ref.id, type: 'codeFile', position: ref.position, selected: selection?.kind === 'file' && selection.id === ref.id, data: { name: file.path, description: ref.note || file.description, count: project.fileRefs.filter(r => r.fileId === file.id).length, onOpen: () => { void openCode(file.id); } } }] : []; });
    const moduleNode = (n: DesignNode, position = n.position, parentId?: string): Node => {
      const isExpanded = expanded.includes(n.id) && !parentId;
      const layout = isExpanded && n.parentId === null ? expandedLayout(project, n) : undefined;
      return { id: n.id, type: 'module', position, parentId, extent: parentId ? 'parent' : undefined, draggable: !parentId, selected: selection?.kind === 'node' && selection.id === n.id, style: layout ? { width: layout.width, height: layout.height } : undefined, data: { name: n.name, description: n.description, inputs: n.inputs, outputs: n.outputs, depth: nodeDepth(project, n.id), childNames: n.parentId === null ? project.nodes.filter(child => child.parentId === n.id).map(child => child.name) : project.fileRefs.filter(r => r.nodeId === n.id).map(r => project.files.find(f => f.id === r.fileId)?.path || ''), expanded: isExpanded, width: layout?.width, height: layout?.height, onEnter: () => enter(n.id), onExpand: () => { setExpanded(prev => prev.includes(n.id) ? prev.filter(id => id !== n.id) : [...prev, n.id]); setTimeout(() => { void fitView({ padding: 0.18, maxZoom: 1, duration: 180 }); }, 100); } } };
    };
    const boundaries = (module: DesignNode, parentId?: string): Node[] => {
      const layout = expandedLayout(project, module);
      const children = project.nodes.filter(n => n.parentId === module.id);
      const minX = children.length ? Math.min(...children.map(n => n.position.x)) : 250;
      const minY = children.length ? Math.min(...children.map(n => n.position.y)) : 200;
      const maxX = Math.max(minX + 264, ...children.map(n => n.position.x + 264));
      return (['input', 'output'] as const).map(direction => ({ id: boundaryId(module.id, direction), type: 'boundary', parentId, extent: parentId ? 'parent' : undefined, draggable: false, selectable: false, position: parentId ? { x: direction === 'input' ? 24 : layout.outputX, y: minY + layout.offset.y } : { x: direction === 'input' ? minX - 235 : maxX + 65, y: minY }, data: { moduleId: module.id, name: module.name, direction, ports: direction === 'input' ? module.inputs : module.outputs, onBind: () => addBinding(module.id, direction) } }));
    };
    const result: Node[] = [];
    for (const n of project.nodes.filter(node => node.parentId === graphId)) {
      const offset = n.parentId === null ? rootOffsets.get(n.id) : undefined;
      result.push(moduleNode(n, offset ? { x: n.position.x + offset.x, y: n.position.y + offset.y } : n.position));
      if (n.parentId === null && expanded.includes(n.id)) {
        const layout = expandedLayout(project, n);
        result.push(...boundaries(n, n.id));
        result.push(...project.nodes.filter(child => child.parentId === n.id).map(child => moduleNode(child, { x: child.position.x + layout.offset.x, y: child.position.y + layout.offset.y }, n.id)));
      }
    }
    if (graphNode && !fileLayer) result.push(...boundaries(graphNode));
    return result;
  }, [project, graphId, fileLayer, selection, expanded, enter, dirty, rootOffsets]);
  const canvasEdges: Edge[] = useMemo(() => {
    if (!project || fileLayer) return [];
    const visible = new Set(canvasNodes.map(node => node.id));
    const absoluteY = (id: string): number => { const node = canvasNodes.find(n => n.id === id); return node ? node.position.y + (node.parentId ? canvasNodes.find(n => n.id === node.parentId)?.position.y || 0 : 0) : 0; };
    const edges: Edge[] = project.edges.filter(e => visible.has(e.source) && visible.has(e.target)).map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourcePort || '__default-out', targetHandle: e.targetPort || '__default-in', type: 'relation', zIndex: 2, data: { isLoop: e.loop, loopTop: Math.min(absoluteY(e.source), absoluteY(e.target)) - 52, onSelect: () => { setSelection({ kind: 'edge', id: e.id }); setInspectorOpen(true); setTab('design'); } }, label: `${e.loop ? '↻ ' : ''}${e.relation || '连接规则待说明'}`, selected: selection?.kind === 'edge' && selection.id === e.id, style: { stroke: e.loop ? flowColors.loop : selection?.id === e.id ? flowColors.selected : flowColors.connection, strokeWidth: selection?.id === e.id ? 2.5 : 1.7, strokeDasharray: e.loop ? '6 5' : undefined }, markerEnd: { type: MarkerType.ArrowClosed, color: e.loop ? flowColors.loop : selection?.id === e.id ? flowColors.selected : flowColors.connection, width: 18, height: 18 } }));
    edges.push(...project.bindings.filter(b => visible.has(boundaryId(b.moduleId, b.direction)) && visible.has(b.childNodeId)).map(b => {
      const siblings = project.nodes.filter(n => n.parentId === b.moduleId);
      const lane = project.bindings.filter(other => other.moduleId === b.moduleId && other.direction === b.direction).findIndex(other => other.id === b.id);
      const routeY = b.direction === 'input' ? Math.min(...siblings.map(n => absoluteY(n.id))) - 38 - lane * 37 : Math.max(...siblings.map(n => absoluteY(n.id) + moduleHeight(n))) + 26 + lane * 37;
      return { id: `__binding:${b.id}`, source: b.direction === 'input' ? boundaryId(b.moduleId, b.direction) : b.childNodeId, target: b.direction === 'input' ? b.childNodeId : boundaryId(b.moduleId, b.direction), sourceHandle: b.direction === 'input' ? b.modulePortId : b.childPortId, targetHandle: b.direction === 'input' ? b.childPortId : b.modulePortId, type: 'relation', zIndex: 2, data: { routeY, onSelect: () => setBindingDraft({ ...b }) }, label: b.description || (b.direction === 'input' ? '模块输入 → 内部输入' : '内部输出 → 模块输出'), style: { stroke: flowColors.binding, strokeWidth: 1.7, strokeDasharray: '5 4' }, markerEnd: { type: MarkerType.ArrowClosed, color: flowColors.binding, width: 18, height: 18 } };
    }));
    return edges;
  }, [project, graphId, fileLayer, selection, canvasNodes]);
  const onNodesChange: OnNodesChange = changes => { const positions = changes.filter((change): change is NodePositionChange => change.type === 'position' && Boolean(change.position)); if (!positions.length) return; edit(p => fileLayer ? { ...p, fileRefs: p.fileRefs.map(ref => { const change = positions.find(c => c.id === ref.id); return change?.position ? { ...ref, position: change.position } : ref; }) } : { ...p, nodes: p.nodes.map(n => { const change = positions.find(c => c.id === n.id); const offset = n.parentId === null ? rootOffsets.get(n.id) : undefined; return change?.position ? { ...n, position: { x: change.position.x - (offset?.x || 0), y: change.position.y - (offset?.y || 0) } } : n; }) }, false); };
  const connect = (connection: Connection) => {
    const sourceBoundary = canvasNodes.find(n => n.id === connection.source && n.type === 'boundary')?.data as BoundaryData | undefined;
    const targetBoundary = canvasNodes.find(n => n.id === connection.target && n.type === 'boundary')?.data as BoundaryData | undefined;
    const source = project?.nodes.find(n => n.id === connection.source);
    const target = project?.nodes.find(n => n.id === connection.target);
    if (sourceBoundary?.direction === 'input' && target?.parentId === sourceBoundary.moduleId && connection.sourceHandle && connection.targetHandle && !connection.targetHandle.startsWith('__')) { addBinding(sourceBoundary.moduleId, 'input', { modulePortId: connection.sourceHandle, childNodeId: target.id, childPortId: connection.targetHandle }); return; }
    if (targetBoundary?.direction === 'output' && source?.parentId === targetBoundary.moduleId && connection.sourceHandle && connection.targetHandle && !connection.sourceHandle.startsWith('__')) { addBinding(targetBoundary.moduleId, 'output', { modulePortId: connection.targetHandle, childNodeId: source.id, childPortId: connection.sourceHandle }); return; }
    if (!source || !target || source.parentId !== target.parentId) { setError('跨层连接请通过模块的命名输入输出建立接口绑定。'); return; }
    setEdgeDraft({ graphId: source.parentId, source: source.id, target: target.id, sourcePort: connection.sourceHandle?.startsWith('__') ? null : connection.sourceHandle || null, targetPort: connection.targetHandle?.startsWith('__') ? null : connection.targetHandle || null, relation: '', loop: source.id === target.id, loopNote: '' });
  };
  const addEdge = () => { const siblings = project?.nodes.filter(n => n.parentId === graphId) || []; if (!siblings.length) { setError('请先添加模块，再创建连接。'); return; } setEdgeDraft({ graphId, source: siblings[0].id, target: siblings[1]?.id || siblings[0].id, sourcePort: siblings[0].outputs[0]?.id || null, targetPort: siblings[1]?.inputs[0]?.id || null, relation: '', loop: siblings.length === 1, loopNote: '' }); };
  const commitEdge = () => { if (!edgeDraft) return; const edge: DesignEdge = { id: uid('edge'), ...edgeDraft }; edit(p => ({ ...p, edges: [...p.edges, edge] })); setEdgeDraft(null); setSelection({ kind: 'edge', id: edge.id }); };
  const openFileDialog = () => { setFileDialog(true); setFilePath(''); void api<{ files: string[] }>('/api/workspace-files').then(data => setFilePaths(data.files)).catch(fail); };
  const linkFile = () => { if (!graphId) return; try { edit(p => attachFile(p, graphId, filePath)); setFileDialog(false); setNotice('已添加文件引用。映射不会自动创建代码文件。'); } catch (e) { fail(e); } };
  const importProject = async (file: File) => { try { const parsed = validateProject(JSON.parse(await file.text())); if (!window.confirm(`导入「${parsed.name}」将替换当前画布；保存后才会写入项目目录。是否继续？`)) return; edit(() => parsed); setGraphId(null); setSelection(null); setNotice('已导入画布，请保存以写入项目'); } catch (e) { fail(e); } };
  const exportProject = () => { if (!project) return; const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'research-canvas.json'; anchor.click(); URL.revokeObjectURL(url); };
  const previewTask = async () => { if (!contextNode || dirty) return; const key = taskContextKey; const request = ++previewRequest.current; setTaskBusy(true); setError(''); try { const result = await api<{ prompt: string; revision:number }>('/api/tasks/preview', { method: 'POST', body: JSON.stringify({ nodeId: contextNode.id, kind: taskKind, instruction }) }); if (taskContextRef.current === key && previewRequest.current === request) { setPrompt(result.prompt); setPromptKey(key);setPromptRevision(result.revision); } } catch (e) { if (taskContextRef.current === key) fail(e); } finally { setTaskBusy(false); } };
  const launchTask = async () => { if (!contextNode || dirty) return; if (!prompt || promptKey !== taskContextKey || promptRevision===null) { setError('任务要求已变化，请重新预览上下文。'); return; } setTaskBusy(true); setError(''); try { const result = await api<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify({ nodeId: contextNode.id, kind: taskKind, instruction,expectedRevision:promptRevision }) }); setTask(result.task); } catch (e) { fail(e); } finally { setTaskBusy(false); } };
  const taskAction = async (action: string, body: unknown = {}) => { if (!task) return; try { const result = await api<{ task?: Task }>(`/api/tasks/${task.id}/${action}`, { method: 'POST', body: JSON.stringify(body) }); if (result.task) setTask(result.task); else { const fresh = await api<{ task: Task }>(`/api/tasks/${task.id}`); setTask(fresh.task); } } catch (e) { fail(e); } };
  const breadcrumbs = graphNode ? graphNode.parentId ? [project?.nodes.find(n => n.id === graphNode.parentId), graphNode] : [graphNode] : [];
  const siblingNodes = project?.nodes.filter(n => n.parentId === graphId) || [];
  const bindingFields = (value: PortBinding, patch: (next: Partial<PortBinding>) => void) => {
    const module = project?.nodes.find(n => n.id === value.moduleId);
    const children = project?.nodes.filter(n => n.parentId === value.moduleId) || [];
    const child = children.find(n => n.id === value.childNodeId);
    const outerPorts = value.direction === 'input' ? module?.inputs : module?.outputs;
    const innerPorts = value.direction === 'input' ? child?.inputs : child?.outputs;
    const otherSources = value.direction === 'output' ? project?.bindings.filter(b => b.id !== value.id && b.moduleId === value.moduleId && b.direction === 'output' && b.modulePortId === value.modulePortId).length || 0 : 0;
    return <><p className="binding-direction-note">{value.direction === 'input' ? '模块输入 → 内部功能输入。同一个模块输入可以分给多个功能。' : '内部功能输出 → 模块输出。多个来源需要说明如何合并。'}</p><Field label="绑定方向"><select value={value.direction} onChange={e => { const direction = e.target.value as 'input' | 'output'; patch({ direction, modulePortId: (direction === 'input' ? module?.inputs : module?.outputs)?.[0]?.id || '', childPortId: (direction === 'input' ? child?.inputs : child?.outputs)?.[0]?.id || '' }); }}><option value="input">输入：模块 → 内部功能</option><option value="output">输出：内部功能 → 模块</option></select></Field><Field label={value.direction === 'input' ? '模块输入端口' : '模块输出端口'}><select value={value.modulePortId} onChange={e => patch({ modulePortId: e.target.value })}><option value="">请选择端口</option>{outerPorts?.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}</select></Field><Field label="内部功能"><select value={value.childNodeId} onChange={e => { const next = children.find(n => n.id === e.target.value); patch({ childNodeId: e.target.value, childPortId: (value.direction === 'input' ? next?.inputs : next?.outputs)?.[0]?.id || '' }); }}><option value="">请选择功能</option>{children.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field><Field label={value.direction === 'input' ? '功能输入端口' : '功能输出端口'}><select value={value.childPortId} onChange={e => patch({ childPortId: e.target.value })}><option value="">请选择端口</option>{innerPorts?.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}</select></Field><Field label="绑定与转换说明" hint="先说明数据如何传递；如需筛选、拆分、转换或合并，在这里描述。"><textarea rows={4} value={value.description} onChange={e => patch({ description: e.target.value })} placeholder="例如：把样本数据同时提供给预处理和统计分析；不改变数据内容。" /></Field>{(!outerPorts?.length || !innerPorts?.length) && <p className="info-note">请先为模块和内部功能添加对应方向的命名端口。</p>}{otherSources > 0 && <p className="info-note">这个模块输出还有 {otherSources} 个内部来源。请明确合并方式，例如拼接、求和或按条件选择；当前仅记录设计关系。</p>}</>;
  };
  const bindingsEditor = (module: DesignNode) => <section className="inspector-section bindings-editor"><div className="section-heading"><h3>接口绑定</h3><button className="text-button" onClick={() => addBinding(module.id)}><Glyph name="plus" size={13} />添加绑定</button></div><p className="small muted">把模块的外层输入输出与内部功能对应起来。输入可分发给多个功能。</p>{project?.bindings.filter(b => b.moduleId === module.id).map(binding => {
    const child = project.nodes.find(n => n.id === binding.childNodeId);
    const outer = (binding.direction === 'input' ? module.inputs : module.outputs).find(port => port.id === binding.modulePortId);
    const inner = (binding.direction === 'input' ? child?.inputs : child?.outputs)?.find(port => port.id === binding.childPortId);
    const multipleOutput = binding.direction === 'output' && project.bindings.filter(b => b.moduleId === module.id && b.direction === 'output' && b.modulePortId === binding.modulePortId).length > 1;
    return <button className="binding-record" key={binding.id} onClick={() => setBindingDraft({ ...binding })}><span className="binding-kind">{binding.direction === 'input' ? '输入分发' : '输出映射'}</span><strong>{binding.direction === 'input' ? `${outer?.name} → ${child?.name}.${inner?.name}` : `${child?.name}.${inner?.name} → ${outer?.name}`}</strong><small>{binding.description || '点击补充绑定说明'}{multipleOutput && ' · 多来源：需明确合并规则'}</small></button>;
  })}{!project?.bindings.some(b => b.moduleId === module.id) && <p className="small muted">尚未绑定。进入内部画布后，也可以从边界端口拖线到功能端口。</p>}</section>;
  const portEditor = (node: DesignNode, direction: 'inputs' | 'outputs') => <section className="inspector-section"><div className="section-heading"><h3>{direction === 'inputs' ? '输入' : '输出'}</h3><button className="text-button" onClick={() => updateNode(node.id, { [direction]: [...node[direction], { id: uid('port'), name: `${direction === 'inputs' ? '输入' : '输出'} ${node[direction].length + 1}`, description: '' }] })}><Glyph name="plus" size={13} />添加</button></div>{!node[direction].length && <p className="small muted">添加命名端口，再从圆点连接模块。</p>}{node[direction].map((port, index) => <div className="port-editor" key={port.id}><div className="port-editor-heading"><span className={`port-dot ${direction}`} /><input aria-label={`${direction === 'inputs' ? '输入' : '输出'} ${index + 1} 名称`} value={port.name} onChange={e => updateNode(node.id, { [direction]: node[direction].map(p => p.id === port.id ? { ...p, name: e.target.value } : p) })} /><button className="icon-button" title="移除端口及其连接引用" aria-label="移除端口" onClick={() => edit(p => removePort(p, node.id, direction, port.id))}><Glyph name="close" size={12} /></button></div><textarea aria-label={`${port.name}说明`} placeholder="输入自然语言说明…" value={port.description} rows={2} onChange={e => updateNode(node.id, { [direction]: node[direction].map(p => p.id === port.id ? { ...p, description: e.target.value } : p) })} /><details><summary>类型与形状（可选）</summary><input aria-label={`${port.name}数据类型`} placeholder="数据类型，如 float32" value={port.dataType || ''} onChange={e => updateNode(node.id, { [direction]: node[direction].map(p => p.id === port.id ? { ...p, dataType: e.target.value } : p) })} /><input aria-label={`${port.name}张量形状`} placeholder="形状，如 [batch, dim]" value={port.shape || ''} onChange={e => updateNode(node.id, { [direction]: node[direction].map(p => p.id === port.id ? { ...p, shape: e.target.value } : p) })} /></details></div>)}</section>;
  const edgeFields = (value: EdgeDraft | DesignEdge, patch: (next: Partial<EdgeDraft>) => void) => <><div className="two-fields"><Field label="从节点"><select value={value.source} onChange={e => patch({ source: e.target.value, sourcePort: null })}>{project?.nodes.filter(n => n.parentId === value.graphId).map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field><Field label="到节点"><select value={value.target} onChange={e => patch({ target: e.target.value, targetPort: null })}>{project?.nodes.filter(n => n.parentId === value.graphId).map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field></div><div className="two-fields"><Field label="使用输出"><select value={value.sourcePort || ''} onChange={e => patch({ sourcePort: e.target.value || null })}><option value="">未指定</option>{project?.nodes.find(n => n.id === value.source)?.outputs.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}</select></Field><Field label="连接输入"><select value={value.targetPort || ''} onChange={e => patch({ targetPort: e.target.value || null })}><option value="">未指定</option>{project?.nodes.find(n => n.id === value.target)?.inputs.map(port => <option key={port.id} value={port.id}>{port.name}</option>)}</select></Field></div><Field label="关系与判断规则" hint="自由描述何时流向目标节点；位置不决定执行顺序。"><textarea value={value.relation} onChange={e => patch({ relation: e.target.value })} rows={4} placeholder="例如：误差未达到阈值，并且迭代次数小于 100 时返回优化模块" /></Field><label className="checkbox-label"><input type="checkbox" checked={value.loop} onChange={e => patch({ loop: e.target.checked })} />这条连接表示循环</label>{value.loop && <Field label="循环与停止条件说明"><textarea value={value.loopNote} onChange={e => patch({ loopNote: e.target.value })} rows={3} placeholder="收敛条件、次数上限、退出后的结果…" /></Field>}<p className="info-note">自然语言规则用于设计。需与 Codex 澄清并转换为实际代码。</p></>;
  if (!project) return <div className="loading-screen"><Glyph name="layers" size={34} /><h1>Research Canvas</h1><p>{busy ? '正在打开本地项目…' : error || '无法读取项目'}</p>{!busy && <button className="primary" onClick={() => { void load(); }}>重新连接</button>}</div>;
  return <div className="app-shell">
    <header className="app-header"><div className="brand"><div className="brand-mark"><Glyph name="layers" size={21} /></div><span>Research Canvas<small>本地研究设计工作台</small></span></div><div className="project-title"><input aria-label="项目名称" value={project.name} onChange={e => edit(p => ({ ...p, name: e.target.value }))} /><span className={`save-status ${dirty ? 'dirty' : ''}`}><i />{dirty ? '有未保存的更改' : `已保存 · r${revision.current}`}</span></div><div className="header-actions"><button className="subtle" onClick={exportProject}>导出</button><button className="subtle" onClick={() => importInput.current?.click()}>导入</button><button className="primary save-button" disabled={saving || !dirty} onClick={() => { void save(); }}><Glyph name="save" size={15} />{saving ? '保存中…' : '保存项目'}</button><input hidden ref={importInput} type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void importProject(file); e.target.value = ''; }} /></div></header>
    {(error || notice) && <div role={error ? 'alert' : 'status'} className={`message-bar ${error ? 'error' : 'success'}`}><span>{error || notice}</span>{error && /版本|冲突|revision|changed|409/i.test(error) && <button onClick={() => { if (window.confirm('重新读取会放弃当前未保存的修改。建议先导出备份。是否继续？')) void load(); }}>重新读取</button>}<button className="icon-button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}><Glyph name="close" size={14} /></button></div>}
    <div className="canvas-toolbar"><nav className="breadcrumbs" aria-label="画布路径"><button className={graphId === null ? 'current' : ''} onClick={() => enter(null)}>整体框架</button>{breadcrumbs.map(node => node && <span key={node.id}><span className="breadcrumb-slash">/</span><button className={node.id === graphId ? 'current' : ''} onClick={() => enter(node.id)}>{node.name}</button></span>)}</nav><div className="toolbar-actions"><button className="icon-button" title="撤销" aria-label="撤销" disabled={!history.current.length} onClick={undo}><Glyph name="undo" size={17} /></button>{!fileLayer && <button onClick={addEdge}><Glyph name="link" size={15} />添加连接</button>}<button className="primary" onClick={fileLayer ? openFileDialog : addNode}><Glyph name="plus" size={16} />{fileLayer ? '关联代码文件' : canvasLevel === 1 ? '添加模块' : '添加功能'}</button><button className="icon-button inspector-toggle" aria-label="切换属性面板" onClick={() => setInspectorOpen(v => !v)}><Glyph name="layers" size={17} /></button></div></div>
    <main className={`main-area ${inspectorOpen ? '' : 'inspector-hidden'}`}><section ref={canvasContainer} className="canvas-area" aria-label={`${canvasLevel} 层画布`}><div className="canvas-caption"><span className="level-badge">0{canvasLevel}</span><div><strong>{fileLayer ? '代码文件映射' : graphId ? '模块内部功能' : '整体框架与模块'}</strong><small>{fileLayer ? '同一代码文件可被多个功能引用' : '手动添加节点，用连线表达模块之间的关系'}</small></div></div>{graphNode && !fileLayer && <div className="parent-boundary"><span>模块边界</span><span>输入：{graphNode.inputs.map(p => p.name).join('、') || '待定义'}</span><Glyph name="arrow" size={12} /><span>输出：{graphNode.outputs.map(p => p.name).join('、') || '待定义'}</span><button onClick={() => { setSelection({ kind: 'node', id: graphNode.id }); setTab('design'); }}>编辑边界</button><button onClick={() => addBinding(graphNode.id)}>添加接口绑定</button></div>}
      <ReactFlow nodes={canvasNodes} edges={canvasEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onConnect={connect} onNodeClick={(event, node) => { setSelection({ kind: node.type === 'boundary' ? 'node' : fileLayer ? 'file' : 'node', id: node.type === 'boundary' ? String(node.data.moduleId) : node.id }); setInspectorOpen(true); setTab('design'); if (node.type !== 'boundary' && !(event.target instanceof Element && event.target.closest('button'))) focusNode(node.id); }} onNodeDoubleClick={(_, node) => { if (!fileLayer && node.type !== 'boundary') enter(node.id); }} onEdgeClick={(_, edge) => { if (edge.id.startsWith('__binding:')) { const binding = project.bindings.find(b => `__binding:${b.id}` === edge.id); if (binding) setBindingDraft({ ...binding }); return; } setSelection({ kind: 'edge', id: edge.id }); setInspectorOpen(true); setTab('design'); }} onPaneClick={() => setSelection(null)} onNodeDragStart={() => { if (current.current) history.current.push(current.current); rerender(n => n + 1); }} fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }} minZoom={0.25} maxZoom={1.6} deleteKeyCode={null} proOptions={{ hideAttribution: true }}><Background gap={24} size={1} color="#b9c3d1" /><Controls showInteractive={false} /></ReactFlow>
      {!(fileLayer ? canvasNodes.length : siblingNodes.length) && <div className="empty-canvas"><div className="empty-art"><div /><span><Glyph name={fileLayer ? 'file' : 'plus'} size={28} /></span><div /></div><h2>{fileLayer ? '把这个功能映射到代码' : graphId ? '从第一个功能开始' : '从一个研究想法开始'}</h2><p>{fileLayer ? '关联项目中的现有文件，或先记录计划路径。' : '把想法拆成模块，逐步讨论输入、输出与实现。'}</p><button className="primary" onClick={fileLayer ? openFileDialog : addNode}><Glyph name="plus" size={16} />{fileLayer ? '关联第一个文件' : graphId ? '添加第一个功能' : '添加第一个模块'}</button>{!graphId && <button className="example-button" onClick={() => { if (window.confirm('载入示例将替换当前画布。示例路径、调研与方案均未验证。是否继续？')) { edit(() => createExampleProject()); setSelection(null); setTimeout(() => { void fitView({ padding: 0.2, maxZoom: 1 }); }, 100); } }}>或体验 A / B / C 示例 <Glyph name="arrow" size={12} /></button>}</div>}
      <div className="canvas-footer"><span>{fileLayer ? canvasNodes.length : siblingNodes.length} 个{fileLayer ? '文件引用' : canvasLevel === 1 ? '模块' : '功能'} {!fileLayer && `· ${canvasEdges.length} 条连接`}</span><span>点击放大 · 双击进入 · 左下角适配全图</span></div>
    </section><aside className="inspector"><div className="inspector-title"><span className="eyebrow">{selectedEdge ? '连接属性' : selectedFile ? '文件映射' : selectedNode ? nodeDepth(project, selectedNode.id) === 1 ? '模块属性' : '功能属性' : graphNode ? '当前画布' : '项目概览'}</span><button className="icon-button mobile-close" aria-label="关闭属性面板" onClick={() => setInspectorOpen(false)}><Glyph name="close" size={15} /></button></div>{contextNode && !selectedEdge && !selectedFile && <div className="inspector-tabs">{(['design', 'research', 'proposals'] as const).map(value => <button key={value} aria-pressed={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'design' ? '设计' : value === 'research' ? '调研' : '方案'}{value === 'research' && <small>{project.research.filter(r => r.nodeId === contextNode.id).length}</small>}{value === 'proposals' && <small>{project.proposals.filter(r => r.nodeId === contextNode.id).length}</small>}</button>)}</div>}
      <div className="inspector-scroll">{selectedEdge ? <><h2>编辑连接</h2>{edgeFields(selectedEdge, patch => updateEdge(selectedEdge.id, patch))}<button className="danger-link" onClick={() => { edit(p => ({ ...p, edges: p.edges.filter(e => e.id !== selectedEdge.id) })); setSelection(null); }}>删除这条连接</button></> : selectedFile && selectedRef ? <><h2 className="file-title">{selectedFile.path.split('/').pop()}</h2><Field label="项目相对路径" hint="共享文件属性的修改会影响所有引用；不会移动磁盘文件。"><input value={selectedFile.path} onChange={e => updateFile(selectedFile.id, { path: e.target.value })} /></Field><Field label="文件说明（共享）"><textarea value={selectedFile.description} rows={4} onChange={e => updateFile(selectedFile.id, { description: e.target.value })} /></Field><Field label="在当前功能中的职责"><textarea value={selectedRef.note} rows={4} onChange={e => updateRef(selectedRef.id, { note: e.target.value })} placeholder="这个文件为当前功能负责什么？" /></Field><div className="info-note">{project.fileRefs.filter(r => r.fileId === selectedFile.id).length} 个功能引用这份文件。移除映射只解除当前引用。</div><button className="secondary full-width" onClick={() => { void openCode(selectedFile.id); }}><Glyph name="file" size={15} />在 VS Code 中打开</button><button className="danger-link" onClick={() => { edit(p => ({ ...p, fileRefs: p.fileRefs.filter(r => r.id !== selectedRef.id) })); setSelection(null); }}>移除当前功能的引用</button></> : contextNode ? <>{tab === 'design' && <><Field label={nodeDepth(project, contextNode.id) === 1 ? '模块名称' : '功能名称'}><input value={contextNode.name} onChange={e => updateNode(contextNode.id, { name: e.target.value })} /></Field><Field label="设计说明"><textarea rows={4} value={contextNode.description} onChange={e => updateNode(contextNode.id, { description: e.target.value })} placeholder="它解决什么问题，具体负责什么？" /></Field>{portEditor(contextNode, 'inputs')}{portEditor(contextNode, 'outputs')}{contextNode.parentId === null && bindingsEditor(contextNode)}<section className="inspector-section"><Field label="分支与判断规则" hint="先用自然语言说明，条件和边界可继续与 Codex 讨论。"><textarea rows={4} value={contextNode.branchRule} onChange={e => updateNode(contextNode.id, { branchRule: e.target.value })} placeholder="例如：若误差小于阈值则结束，否则继续迭代，最多 100 次。" /></Field></section>{selectedNode && <button className="secondary full-width" onClick={() => enter(contextNode.id)}>{nodeDepth(project, contextNode.id) === 1 ? '进入内部功能画布' : '进入代码文件映射'}<Glyph name="arrow" size={14} /></button>}<button className="danger-link" onClick={() => { if (window.confirm(`删除「${contextNode.name}」及其内部功能、连线和引用？实际代码文件不会被删除。`)) { edit(p => removeNode(p, contextNode.id)); if (graphId === contextNode.id) enter(contextNode.parentId); setSelection(null); } }}>删除{nodeDepth(project, contextNode.id) === 1 ? '模块' : '功能'}</button></>}
      {tab === 'research' && <><div className="section-heading"><h2>调研记录</h2><button className="text-button" onClick={() => edit(p => ({ ...p, research: [...p.research, { id: uid('research'), nodeId: contextNode.id, title: '新调研记录', url: '', notes: '', status: 'unverified' }] }))}><Glyph name="plus" size={13} />添加</button></div><p className="small muted">保存来源与判断依据。核实标记由你明确设置。</p>{project.research.filter(r => r.nodeId === contextNode.id).map(record => <div className="record-card" key={record.id}><Field label="标题"><input value={record.title} onChange={e => edit(p => ({ ...p, research: p.research.map(r => r.id === record.id ? { ...r, title: e.target.value } : r) }))} /></Field><Field label="来源 URL"><input value={record.url} placeholder="https://…" onChange={e => edit(p => ({ ...p, research: p.research.map(r => r.id === record.id ? { ...r, url: e.target.value } : r) }))} /></Field><Field label="要点与依据"><textarea value={record.notes} rows={4} onChange={e => edit(p => ({ ...p, research: p.research.map(r => r.id === record.id ? { ...r, notes: e.target.value } : r) }))} /></Field><label className="checkbox-label"><input type="checkbox" checked={record.status === 'verified'} onChange={e => edit(p => ({ ...p, research: p.research.map(r => r.id === record.id ? { ...r, status: e.target.checked ? 'verified' : 'unverified' } : r) }))} />我已核实这条来源与记录</label><button className="danger-link" onClick={() => edit(p => ({ ...p, research: p.research.filter(r => r.id !== record.id) }))}>移除记录</button></div>)}{!project.research.some(r => r.nodeId === contextNode.id) && <div className="empty-inspector"><Glyph name="spark" size={24} /><p>从待解决的问题开始调研，<br />将可靠来源记录在这里。</p></div>}</>}
      {tab === 'proposals' && <><div className="section-heading"><h2>候选方案</h2><button className="text-button" onClick={() => edit(p => ({ ...p, proposals: [...p.proposals, { id: uid('proposal'), nodeId: contextNode.id, title: '新候选方案', description: '', selected: false }] }))}><Glyph name="plus" size={13} />添加</button></div><p className="small muted">对比后选择一个方案，作为实现任务的依据。</p>{project.proposals.filter(r => r.nodeId === contextNode.id).map(proposal => <div className={`record-card ${proposal.selected ? 'chosen' : ''}`} key={proposal.id}><Field label="方案名称"><input value={proposal.title} onChange={e => edit(p => ({ ...p, proposals: p.proposals.map(r => r.id === proposal.id ? { ...r, title: e.target.value } : r) }))} /></Field><Field label="方法、权衡与实现思路"><textarea rows={6} value={proposal.description} onChange={e => edit(p => ({ ...p, proposals: p.proposals.map(r => r.id === proposal.id ? { ...r, description: e.target.value } : r) }))} /></Field><button className={proposal.selected ? 'chosen-button' : 'secondary full-width'} onClick={() => edit(p => ({ ...p, proposals: p.proposals.map(r => r.nodeId === contextNode.id ? { ...r, selected: r.id === proposal.id ? !r.selected : false } : r) }))}>{proposal.selected ? '✓ 已选择此方案' : '选择此方案'}</button><button className="danger-link" onClick={() => edit(p => ({ ...p, proposals: p.proposals.filter(r => r.id !== proposal.id) }))}>移除方案</button></div>)}{!project.proposals.some(r => r.nodeId === contextNode.id) && <div className="empty-inspector"><Glyph name="layers" size={24} /><p>记录可行的方法，<br />与 Codex 一起比较并做出选择。</p></div>}</>}
      </> : <><h2>把想法组织成可实现的结构</h2><p className="overview-copy">手动画出研究模块，逐层拆分功能，再映射到项目代码。</p><div className="layer-guide"><div><b>01</b><span>整体框架<small>模块、输入输出与关系</small></span></div><div><b>02</b><span>功能细分<small>模块内部的设计与判断规则</small></span></div><div><b>03</b><span>代码文件<small>同一文件可被多个功能引用</small></span></div></div><Field label="项目说明"><textarea rows={4} value={project.description} onChange={e => edit(p => ({ ...p, description: e.target.value }))} placeholder="研究目标、背景与约束…" /></Field><div className="connection-panel"><h3>本地连接</h3><p><i className="status-dot online" />画布服务 <span>已连接</span></p><p><i className={`status-dot ${health?.vscodeAvailable ? 'online' : ''}`} />VS Code 命令 <span>{health?.vscodeAvailable ? '可用' : '未检测到'}</span></p><p><i className={`status-dot ${health?.codex.available ? 'online' : ''}`} />Codex CLI <span>{health?.codex.available ? '已检测到' : '未检测到'}</span></p><small>CLI 可用性检测不代表已登录。插件接入需按项目说明配置。</small></div><details className="workspace-detail"><summary>当前项目目录</summary><code>{workspace}</code></details><button className="subtle full-width" onClick={() => { if (window.confirm('创建空白画布将替换当前设计。是否继续？')) { edit(() => createProject()); enter(null); } }}>创建空白画布</button></>}
      </div>{contextNode && !selectedEdge && !selectedFile && <div className="task-entry"><div><Glyph name="spark" size={17} /><span>围绕这个{nodeDepth(project, contextNode.id) === 1 ? '模块' : '功能'}继续</span></div><button className="primary full-width" onClick={() => { setTaskDialog(true); setPrompt(''); }}>与 Codex 研究和实现<Glyph name="arrow" size={14} /></button><small>{dirty ? '请先保存，让 Codex 读取最新设计' : '先预览上下文，再明确发起任务'}</small></div>}</aside></main>
    {edgeDraft && <div className="modal-overlay" onClick={() => setEdgeDraft(null)}><section className="modal" role="dialog" aria-modal="true" aria-label="添加连接" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">模块关系</span><h2>添加连接</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setEdgeDraft(null)}><Glyph name="close" /></button></div>{edgeFields(edgeDraft, patch => setEdgeDraft({ ...edgeDraft, ...patch }))}<div className="modal-actions"><button className="secondary" onClick={() => setEdgeDraft(null)}>取消</button><button className="primary" onClick={commitEdge}>创建连接</button></div></section></div>}
    {bindingDraft && <div className="modal-overlay" onClick={() => setBindingDraft(null)}><section className="modal binding-modal" role="dialog" aria-modal="true" aria-label="接口绑定" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">模块边界 · {project.nodes.find(n => n.id === bindingDraft.moduleId)?.name}</span><h2>{project.bindings.some(b => b.id === bindingDraft.id) ? '编辑接口绑定' : '添加接口绑定'}</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setBindingDraft(null)}><Glyph name="close" /></button></div>{bindingFields(bindingDraft, patch => setBindingDraft({ ...bindingDraft, ...patch }))}<div className="modal-actions">{project.bindings.some(b => b.id === bindingDraft.id) && <button className="danger-link" onClick={() => { edit(p => ({ ...p, bindings: p.bindings.filter(b => b.id !== bindingDraft.id) })); setBindingDraft(null); }}>删除绑定</button>}<button className="secondary" onClick={() => setBindingDraft(null)}>取消</button><button className="primary" disabled={!bindingDraft.modulePortId || !bindingDraft.childNodeId || !bindingDraft.childPortId} onClick={commitBinding}>保存绑定</button></div></section></div>}
    {fileDialog && <div className="modal-overlay" onClick={() => setFileDialog(false)}><section className="modal" role="dialog" aria-modal="true" aria-label="关联代码文件" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">第三层 · 文件映射</span><h2>关联代码文件</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setFileDialog(false)}><Glyph name="close" /></button></div><Field label="项目相对路径" hint="选择现有文件，或填写计划路径。关联操作不会创建文件。"><input autoFocus list="workspace-paths" value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="例如 src/optimizer.py" /><datalist id="workspace-paths">{[...new Set([...project.files.map(f => f.path), ...filePaths])].map(path => <option key={path} value={path} />)}</datalist></Field>{project.files.length > 0 && <div className="existing-files"><span className="small muted">项目已记录的文件</span>{project.files.slice(0, 8).map(file => <button key={file.id} onClick={() => setFilePath(file.path)}><Glyph name="file" size={14} /><span>{file.path}</span><small>{project.fileRefs.filter(r => r.fileId === file.id).length} 个引用</small></button>)}</div>}<div className="modal-actions"><button className="secondary" onClick={() => setFileDialog(false)}>取消</button><button className="primary" disabled={!filePath.trim()} onClick={linkFile}>添加引用</button></div></section></div>}
    {taskDialog && <div className="modal-overlay" onClick={() => setTaskDialog(false)}><section className="modal task-modal" role="dialog" aria-modal="true" aria-label="Codex 任务" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">CODEX · {contextNode?.name}</span><h2>研究与实现</h2></div><button className="icon-button" aria-label="关闭" onClick={() => setTaskDialog(false)}><Glyph name="close" /></button></div><div className="task-kinds">{(['research', 'plan', 'implement'] as TaskKind[]).map(kind => <button key={kind} className={taskKind === kind ? 'active' : ''} onClick={() => { setTaskKind(kind); setPrompt(''); }}>{taskNames[kind]}</button>)}</div><Field label="补充任务要求"><textarea rows={3} value={instruction} onChange={e => { setInstruction(e.target.value); setPrompt(''); }} placeholder="希望解决的问题、限制条件或需要比较的方法…" /></Field>{dirty && <div className="info-note">当前设计尚未保存。保存后才可预览或发起基于最新模块的任务。</div>}<div className="task-actions"><button className="secondary" disabled={dirty || taskBusy} onClick={() => { void previewTask(); }}>{taskBusy && !task ? '正在读取…' : '预览任务上下文'}</button>{prompt && <button className="subtle" onClick={() => { void navigator.clipboard.writeText(prompt).then(() => setNotice('任务上下文已复制')).catch(fail); }}>复制上下文</button>}<button className="primary" disabled={dirty || !prompt || !health?.codex.available || taskBusy || Boolean(task && ['starting', 'running', 'needs-approval'].includes(task.status))} onClick={() => { void launchTask(); }}><Glyph name="spark" size={15} />发起 Codex 任务</button></div>{prompt && <details className="prompt-preview" open><summary>将提供给 Codex 的上下文</summary><pre>{prompt}</pre></details>}<p className="small muted">任务使用本机 Codex 独立会话和登录状态；实际执行可能请求文件修改或命令批准。当前桌面聊天可通过项目插件读取同一模块。</p>{task && <div className="task-result"><div className="section-heading"><h3>任务：{task.context?.nodeName || '历史任务（模块未记录）'} · {taskNames[task.kind]} · {taskStatus[task.status]}</h3>{['starting', 'running', 'needs-approval'].includes(task.status) && <button className="danger-link" onClick={() => { void taskAction('cancel'); }}>取消任务</button>}</div>{task.approvals.map(approval => <div className="approval-card" key={approval.id}><strong>Codex 请求批准</strong><small>{approval.method}</small><pre>{JSON.stringify(approval.params, null, 2)}</pre><div className="task-actions"><button className="secondary" onClick={() => { void taskAction('approve', { approvalId: approval.id, decision: 'decline' }); }}>拒绝</button><button className="primary" disabled={task.kind !== 'implement'} title={task.kind !== 'implement' ? '调研与方案任务保持只读，不能批准提升权限' : undefined} onClick={() => { void taskAction('approve', { approvalId: approval.id, decision: 'accept' }); }}>批准本次操作</button></div></div>)}{task.error && <p className="task-error">{task.error}</p>}<pre className="task-output">{task.output || (['completed', 'failed', 'cancelled'].includes(task.status) ? '此任务没有返回文本内容。' : '等待 Codex 返回内容…')}</pre>{task.threadId && <small className="muted">独立会话 ID：{task.threadId}</small>}<p className="small muted">任务输出不会自动改写调研和方案记录。确认内容后，可将结果记录到对应模块。</p></div>}</section></div>}
  </div>;
}
export default function App() { return <ReactFlowProvider><AppBody /></ReactFlowProvider>; }

export interface Port { id: string; name: string; description: string; dataType?: string; shape?: string }
export interface DesignNode { id: string; parentId: string | null; name: string; description: string; position: {x: number; y: number}; inputs: Port[]; outputs: Port[]; branchRule: string }
export interface DesignEdge { id: string; graphId: string | null; source: string; target: string; sourcePort: string | null; targetPort: string | null; relation: string; loop: boolean; loopNote: string }
/** Boundary routing is a design record; output contributors require an explicit merge rule before implementation. */
export interface PortBinding { id: string; moduleId: string; direction: 'input' | 'output'; modulePortId: string; childNodeId: string; childPortId: string; description: string }
export interface CodeFile { id: string; path: string; description: string }
export interface FileRef { id: string; nodeId: string; fileId: string; position: {x: number; y: number}; note: string }
export interface ResearchRecord { id: string; nodeId: string; title: string; url: string; notes: string; status: 'unverified' | 'verified' }
export interface Proposal { id: string; nodeId: string; title: string; description: string; selected: boolean }
export interface Project { schemaVersion: 1; id: string; name: string; description: string; revision: number; updatedAt: string; nodes: DesignNode[]; edges: DesignEdge[]; bindings: PortBinding[]; files: CodeFile[]; fileRefs: FileRef[]; research: ResearchRecord[]; proposals: Proposal[] }
export type TaskKind = 'research' | 'plan' | 'implement';

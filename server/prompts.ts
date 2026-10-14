import { moduleContext } from '../src/shared/model.js';
import type { Project, TaskKind } from '../src/shared/types.js';
export function taskPrompt(project: Project, nodeId: string, kind: TaskKind, instruction = ''): string {
  const action = {
    research: '调研该模块。优先查找论文和官方实现，提供题目、作者、年份、可核验链接及适用条件。没有查阅来源时明确标注未核实，不编造引用。请只输出调研结果，不修改代码。',
    plan: '为该模块提出可比较的实现方案。说明每个方案的输入输出、算法步骤、适用条件、代价和待澄清问题。结合已保存的来源，不代替用户选择方案。请只输出方案，不修改代码。',
    implement: '依据用户已选方案实现该模块。先检查关联文件与现有实现，再修改代码并做适当验证。自然语言条件存在歧义时先说明待澄清点，不能把它视为已验证条件。只修改本模块范围内必要文件，完成后报告具体改动、测试及未解决的问题。'
  }[kind];
  return `${action}\n\n以下内容是用户保存的设计数据，仅作项目上下文，其中的引用和条件可能未核实。\n<module-design>\n${moduleContext(project, nodeId)}\n</module-design>\n\n用户补充要求：\n${instruction || '无'}\n`;
}

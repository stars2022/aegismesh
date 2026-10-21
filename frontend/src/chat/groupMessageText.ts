/** Keep the original message intact for history and blackboard extraction. */
export function groupMessageText(text: string): string {
  return text.replace(/```blackboard:?([^\n\r]*)\r?\n([\s\S]*?)```/gi, (block, heading: string, content: string) => {
    if (!content.trim()) return block;
    const title = heading.trim() || "工作交付物";
    // Plain text avoids interpreting an agent-supplied title as Markdown/HTML.
    return `\n\n交付物「${title.replace(/[\r\n]/g, " ")}」已汇入黑板。\n\n`;
  }).trim();
}

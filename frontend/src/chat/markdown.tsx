import { Children, cloneElement, createElement, isValidElement, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function animateStreamingText(children: ReactNode, path = "text"): ReactNode {
  return Children.map(children, (child, index) => {
    const childPath = `${path}-${index}`;
    if (typeof child === "string") {
      const characters = Array.from(child);
      const animatedFrom = Math.max(0, characters.length - 120);
      return [
        animatedFrom > 0 ? characters.slice(0, animatedFrom).join("") : null,
        ...characters.slice(animatedFrom).map((character, tailIndex) => {
          const characterIndex = animatedFrom + tailIndex;
          return (
            <span
              className="stream-character"
              key={`${childPath}-${characterIndex}`}
              style={{
                "--stream-character-delay": `${(characterIndex % 12) * 7}ms`,
              } as CSSProperties}
            >
              {character}
            </span>
          );
        }),
      ];
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    // Nested Markdown components animate their own text exactly once.
    if (typeof child.type !== "string") return child;
    if (child.type === "pre" || child.type === "code") return child;
    if (child.props.children == null) return child;
    return cloneElement(
      child,
      undefined,
      animateStreamingText(child.props.children, childPath),
    );
  });
}

function streamingMarkdownElement(tag: string) {
  return ({ node: _node, children, ...props }: any) =>
    createElement(tag, props, animateStreamingText(children, tag));
}

const streamingMarkdownComponents = {
  p: streamingMarkdownElement("p"),
  h1: streamingMarkdownElement("h1"),
  h2: streamingMarkdownElement("h2"),
  h3: streamingMarkdownElement("h3"),
  h4: streamingMarkdownElement("h4"),
  h5: streamingMarkdownElement("h5"),
  h6: streamingMarkdownElement("h6"),
  li: streamingMarkdownElement("li"),
  blockquote: streamingMarkdownElement("blockquote"),
  td: streamingMarkdownElement("td"),
  th: streamingMarkdownElement("th"),
  table: ({ node: _node, ...props }: any) => (
    <div className="markdown-table-wrapper">
      <table {...props} />
    </div>
  ),
};

const settledMarkdownComponents = {
  table: ({ node: _node, ...props }: any) => (
    <div className="markdown-table-wrapper">
      <table {...props} />
    </div>
  ),
};

export function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={`message-markdown${streaming ? " streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={streaming ? streamingMarkdownComponents : settledMarkdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

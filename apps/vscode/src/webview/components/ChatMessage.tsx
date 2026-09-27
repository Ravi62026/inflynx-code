import React, { useMemo, useState } from "react";
import { marked } from "marked";
import { renderMarkdown } from "../markdown.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import type { ToolCallState } from "./ToolCallCard.js";
import type { AttachmentPayload } from "../../types.js";

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

export function parseThinkTags(rawContent: string, existingThought?: string): { content: string; thought?: string } {
  let thought = existingThought || "";
  let content = rawContent || "";

  if (content.includes("<think>")) {
    const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/gi;
    let match: RegExpExecArray | null;
    const extracted: string[] = [];
    while ((match = thinkRegex.exec(content)) !== null) {
      if (match[1]?.trim()) {
        extracted.push(match[1].trim());
      }
    }
    if (extracted.length > 0) {
      const combined = extracted.join("\n\n");
      thought = thought ? `${thought}\n\n${combined}` : combined;
    }
    content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
  }

  return { content, thought: thought || undefined };
}

interface ChatMessageProps {
  role: "user" | "assistant" | "system";
  content: string;
  thought?: string;
  tools?: ToolCallState[];
  attachments?: AttachmentPayload[];
  isStreaming?: boolean;
  onCopy?: (text: string) => void;
  onOpenFile?: (filePath: string) => void;
}

const ChatMessageComponent: React.FC<ChatMessageProps> = ({
  role,
  content,
  thought,
  tools,
  attachments,
  isStreaming = false,
  onCopy,
  onOpenFile,
}) => {
  const isUser = role === "user";
  const isSystem = role === "system";
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  const { content: displayContent, thought: displayThought } = useMemo(
    () => (isUser || isSystem ? { content, thought } : parseThinkTags(content, thought)),
    [isUser, isSystem, content, thought]
  );

  const renderedSystemHtml = useMemo(() => {
    if (!isSystem || !content) return "";
    try {
      return renderMarkdown(content);
    } catch {
      return content;
    }
  }, [isSystem, content]);

  const renderedHtml = useMemo(() => {
    if (!displayContent) return "";
    try {
      return renderMarkdown(displayContent);
    } catch {
      return displayContent;
    }
  }, [displayContent]);

  if (isSystem) {
    const isApiKeyNotice =
      content.includes("API Key") || content.includes("OPENROUTER") || content.includes("Authentication");

    return (
      <div className="message-item system-error-card">
        <div className="system-error-header">
          <span className="system-error-badge">⚠️ INFLYNX NOTICE</span>
          {isApiKeyNotice && (
            <button
              className="system-quick-action-btn"
              onClick={() => onOpenFile?.(".env")}
              title="Open .env file to configure API keys"
            >
              📝 Open .env
            </button>
          )}
        </div>
        <div
          className="system-error-body"
          dangerouslySetInnerHTML={{ __html: renderedSystemHtml }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === "A") {
              const href = target.getAttribute("href");
              if (href && (href.startsWith("file://") || href.includes("."))) {
                e.preventDefault();
                onOpenFile?.(href.replace(/^file:\/\//, ""));
              }
            }
          }}
        />
      </div>
    );
  }

  // Guard: Never render a blank assistant bubble if there is no content, no thought, no tools, and not currently streaming
  const trimmedContent = displayContent?.trim() || "";
  const trimmedThought = displayThought?.trim() || "";
  const hasTools = Boolean(tools && tools.length > 0);
  if (!isUser && !trimmedContent && !trimmedThought && !hasTools && !isStreaming) {
    return null;
  }

  return (
    <div className={`message-item ${isUser ? "user" : "assistant"}`}>
      <div className="message-role">{isUser ? "You" : "Inflynx Agent"}</div>

      {!isUser && (Boolean(displayThought) || hasTools || isStreaming) && (
        <ThinkingIndicator
          thought={displayThought}
          tools={tools}
          isStreaming={isStreaming}
          hasContent={Boolean(displayContent)}
          onOpenFile={onOpenFile}
        />
      )}

      {isUser ? (
        <div className="user-message-body">
          {attachments && attachments.length > 0 && (
            <div className="message-attachments-container">
              {attachments.map((att, idx) => (
                <div key={idx} className="message-attachment-card">
                  {att.mimeType?.startsWith("image/") ? (
                    <div
                      className="message-attachment-thumb-wrap"
                      onClick={() => setPreviewImage(att.dataUrl)}
                      title={`Click to preview: ${att.name}`}
                    >
                      <img src={att.dataUrl} alt={att.name || "Screenshot"} className="message-attachment-thumb" />
                      <div className="thumb-zoom-overlay">
                        <span>🔍 Preview</span>
                      </div>
                    </div>
                  ) : (
                    <div className="message-attachment-file-chip">
                      <span className="file-chip-icon">📄</span>
                      <span className="file-chip-name">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {displayContent && (
            <div className="message-content" style={{ whiteSpace: "pre-wrap" }}>
              {displayContent}
            </div>
          )}
        </div>
      ) : (
        <>
          {displayContent ? (
            <div
              className="message-content"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.tagName === "A") {
                  const href = target.getAttribute("href");
                  if (href && (href.startsWith("file://") || href.includes("."))) {
                    e.preventDefault();
                    onOpenFile?.(href.replace(/^file:\/\//, ""));
                  }
                }
              }}
            />
          ) : isStreaming ? (
            <div className="agent-thinking-pulse">
              <span className="pulse-spark">⚡</span>
              <span className="pulse-text">
                {hasTools ? "Inflynx Agent is executing actions..." : "Inflynx Agent is thinking..."}
              </span>
              <span className="pulse-dots">
                <span className="pulse-dot dot-1" />
                <span className="pulse-dot dot-2" />
                <span className="pulse-dot dot-3" />
              </span>
            </div>
          ) : hasTools ? (
            <div className="action-completed-note">
              <span>✓ Workspace actions completed successfully.</span>
            </div>
          ) : null}
        </>
      )}

      {/* Lightbox Modal for Image Zoom Preview */}
      {previewImage && (
        <div className="attachment-lightbox-backdrop" onClick={() => setPreviewImage(null)}>
          <div className="attachment-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="attachment-lightbox-header">
              <span className="attachment-lightbox-title">Image Preview</span>
              <button
                type="button"
                className="attachment-lightbox-close"
                onClick={() => setPreviewImage(null)}
                title="Close preview"
              >
                ✕
              </button>
            </div>
            <div className="attachment-lightbox-img-wrap">
              <img src={previewImage} alt="Expanded Screenshot" className="attachment-lightbox-img" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const ChatMessage = React.memo(ChatMessageComponent);

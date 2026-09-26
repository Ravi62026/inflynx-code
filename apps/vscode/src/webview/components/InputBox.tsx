import React, { useState, useRef, useEffect, useCallback } from "react";
import type { AgentMode, ModelInfo, ReasoningEffort, AttachmentPayload } from "../../types.js";
import { describeModelLabel } from "../../models.js";
import { ModelEffortPopover } from "./ModelEffortPopover.js";
import { ModePopover } from "./ModePopover.js";
import { ContextActionPopover } from "./ContextActionPopover.js";

interface InputBoxProps {
  onSend: (prompt: string, attachments?: AttachmentPayload[]) => void;
  onAbort: () => void;
  isRunning: boolean;
  activeMode: AgentMode;
  activeModel: string;
  activeProvider: string;
  activeEffort: ReasoningEffort;
  modelsCatalog: ModelInfo[];
  onSelectMode: (mode: AgentMode) => void;
  onSelectModel: (model: string, provider: string) => void;
  onSelectEffort: (effort: ReasoningEffort) => void;
}

const MODE_ICONS: Record<AgentMode, string> = {
  agent: "⚡",
  plan: "📋",
  ask: "💬",
  debug: "🐞",
};

function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const InputBox: React.FC<InputBoxProps> = ({
  onSend,
  onAbort,
  isRunning,
  activeMode,
  activeModel,
  activeProvider,
  activeEffort,
  modelsCatalog,
  onSelectMode,
  onSelectModel,
  onSelectEffort,
}) => {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showModelEffortPopover, setShowModelEffortPopover] = useState(false);
  const [showModePopover, setShowModePopover] = useState(false);
  const [showContextPopover, setShowContextPopover] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPasteTimeRef = useRef<number>(0);

  // Auto-expand textarea dynamically based on scrollHeight
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const newHeight = Math.max(38, Math.min(textareaRef.current.scrollHeight, 180));
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [text]);

  // Click outside to dismiss popovers
  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowModelEffortPopover(false);
        setShowModePopover(false);
        setShowContextPopover(false);
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    return () => document.removeEventListener("mousedown", handleDocumentClick);
  }, []);

  const processFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    fileArray.forEach((file) => {
      if (file.size > 15 * 1024 * 1024) {
        console.warn(`File ${file.name} exceeds 15MB limit.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const isScreenshotName = !file.name || file.name === "image.png" || file.name === "Screenshot.png";
        const cleanName = isScreenshotName
          ? `screenshot_${new Date().toTimeString().split(" ")[0].replace(/:/g, "")}.png`
          : file.name;

        setAttachments((prev) => {
          // Deduplicate: Don't attach if the same dataUrl or name+size is already present
          if (prev.some((a) => a.dataUrl === dataUrl || (a.name === cleanName && a.size === file.size))) {
            return prev;
          }
          return [
            ...prev,
            {
              name: cleanName,
              mimeType: file.type || "image/png",
              dataUrl,
              size: file.size,
            },
          ];
        });
      };
      reader.readAsDataURL(file);
    });
  }, []);

  // Handle Clipboard Paste (Supports screenshots Cmd+V and images without duplicating)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const now = Date.now();
      // Debounce rapid duplicate paste events
      if (now - lastPasteTimeRef.current < 250) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const filesToProcess: File[] = [];
      const seenSignatures = new Set<string>();

      // Prefer e.clipboardData.files if available as it provides distinct file handles
      if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
        for (let i = 0; i < e.clipboardData.files.length; i++) {
          const file = e.clipboardData.files[i];
          const sig = `${file.name}_${file.size}_${file.type}`;
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            filesToProcess.push(file);
          }
        }
      } else if (e.clipboardData?.items && e.clipboardData.items.length > 0) {
        for (let i = 0; i < e.clipboardData.items.length; i++) {
          const item = e.clipboardData.items[i];
          if (item.kind === "file" || item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              const sig = `${file.name}_${file.size}_${file.type}`;
              if (!seenSignatures.has(sig)) {
                seenSignatures.add(sig);
                filesToProcess.push(file);
              }
            }
          }
        }
      }

      if (filesToProcess.length > 0) {
        lastPasteTimeRef.current = now;
        e.preventDefault();
        e.stopPropagation();
        processFiles(filesToProcess);
      }
    },
    [processFiles]
  );

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles]
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = ""; // Reset input so same file can be picked again
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      setShowModelEffortPopover(false);
      setShowModePopover(false);
      setShowContextPopover(false);
    }
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || isRunning) return;
    const promptToSend = trimmed || "Please analyze the attached image/file.";
    onSend(promptToSend, attachments.length > 0 ? attachments : undefined);
    setText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "38px";
    }
  };

  const handleInsertText = useCallback((insertText: string) => {
    setText((prev) => {
      const needsSpace = prev.length > 0 && !prev.endsWith(" ");
      return prev + (needsSpace ? " " : "") + insertText;
    });
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  }, []);

  const handleRemoveAttachment = (idxToRemove: number) => {
    setAttachments((prev) => prev.filter((_, idx) => idx !== idxToRemove));
  };

  const getCleanModelLabel = (id?: string): string => describeModelLabel(modelsCatalog, id);

  const effortCapitalized = activeEffort
    ? String(activeEffort).charAt(0).toUpperCase() + String(activeEffort).slice(1)
    : "High";

  const modeCapitalized = activeMode
    ? String(activeMode).charAt(0).toUpperCase() + String(activeMode).slice(1)
    : "Agent";

  const canSubmit = (text.trim().length > 0 || attachments.length > 0) && !isRunning;

  return (
    <div className="unified-input-wrapper" ref={containerRef}>
      {/* Hidden File Input for Dialog Uploads */}
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*,.pdf,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py"
        multiple
        style={{ display: "none" }}
        onChange={handleFileInputChange}
      />

      {/* Popovers */}
      {showContextPopover && (
        <ContextActionPopover
          onInsertText={handleInsertText}
          onUploadClick={() => fileInputRef.current?.click()}
          onClose={() => setShowContextPopover(false)}
        />
      )}

      {showModePopover && (
        <ModePopover
          currentMode={activeMode}
          onSelectMode={onSelectMode}
          onClose={() => setShowModePopover(false)}
        />
      )}

      {showModelEffortPopover && (
        <ModelEffortPopover
          activeModel={activeModel}
          activeProvider={activeProvider}
          activeEffort={activeEffort}
          modelsCatalog={modelsCatalog}
          onSelectModel={onSelectModel}
          onSelectEffort={onSelectEffort}
          onClose={() => setShowModelEffortPopover(false)}
        />
      )}

      {/* Unified Floating Card */}
      <div
        className={`unified-input-card ${isDragging ? "drag-over" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Attachment Preview Strip */}
        {attachments.length > 0 && (
          <div className="attachments-preview-strip">
            {attachments.map((att, idx) => (
              <div key={idx} className="attachment-chip" title={att.name}>
                {att.mimeType.startsWith("image/") ? (
                  <img src={att.dataUrl} alt={att.name} className="attachment-thumb" />
                ) : (
                  <span className="attachment-file-icon">📄</span>
                )}
                <div className="attachment-meta">
                  <span className="attachment-name">{att.name}</span>
                  {att.size ? <span className="attachment-size">{formatFileSize(att.size)}</span> : null}
                </div>
                <button
                  type="button"
                  className="attachment-remove-btn"
                  onClick={() => handleRemoveAttachment(idx)}
                  title="Remove attachment"
                  aria-label="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Text Input Area */}
        <textarea
          ref={textareaRef}
          className="unified-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            attachments.length > 0
              ? "Ask anything about attached image/file, or press Enter..."
              : "Ask anything, paste screenshot (Cmd+V), @ to mention, / for actions"
          }
          rows={1}
          disabled={isRunning}
          autoComplete="off"
          spellCheck={false}
        />

        {/* Integrated Bottom Toolbar */}
        <div className="input-toolbar">
          <div className="toolbar-left">
            {/* + Button for context & slash commands */}
            <button
              type="button"
              className="toolbar-btn plus-btn"
              onClick={() => {
                setShowContextPopover((prev) => !prev);
                setShowModePopover(false);
                setShowModelEffortPopover(false);
              }}
              title="Add context, upload file, or mention (+)"
              aria-label="Add Context"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>

            {/* Direct Paperclip / Attachment Button */}
            <button
              type="button"
              className="toolbar-btn attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach screenshot or file"
              aria-label="Attach File"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>

            {/* Mode Dropdown Button */}
            <button
              type="button"
              className={`toolbar-btn toolbar-mode-btn ${showModePopover ? "active" : ""}`}
              onClick={() => {
                setShowModePopover((prev) => !prev);
                setShowContextPopover(false);
                setShowModelEffortPopover(false);
              }}
              title={`Operating Mode: ${modeCapitalized}. Click to switch.`}
            >
              <span className="btn-icon">{MODE_ICONS[activeMode] || "⚡"}</span>
              <span className="btn-label">{modeCapitalized}</span>
              <svg className="btn-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Model & Effort Dropdown Button */}
            <button
              type="button"
              className={`toolbar-btn toolbar-model-btn ${showModelEffortPopover ? "active" : ""}`}
              onClick={() => {
                setShowModelEffortPopover((prev) => !prev);
                setShowContextPopover(false);
                setShowModePopover(false);
              }}
              title={`Active Model: ${getCleanModelLabel(activeModel)} (${effortCapitalized} reasoning effort). Click to change.`}
            >
              <span className="btn-model-name">{getCleanModelLabel(activeModel)}</span>
              {activeEffort && activeEffort !== "none" && (
                <span className="btn-effort-tag">{effortCapitalized}</span>
              )}
              <svg className="btn-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>

          <div className="toolbar-right">
            {/* Microphone Icon Button */}
            <button
              type="button"
              className="toolbar-icon-btn mic-btn"
              title="Voice dictation (Coming soon)"
              disabled
              aria-label="Voice input"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>

            {/* Circular Send / Abort Button */}
            {isRunning ? (
              <button
                type="button"
                className="circular-action-btn abort-btn"
                onClick={onAbort}
                title="Stop generation"
                aria-label="Stop generation"
              >
                <span className="stop-square" />
              </button>
            ) : (
              <button
                type="button"
                className={`circular-action-btn send-btn ${canSubmit ? "active" : ""}`}
                onClick={handleSubmit}
                disabled={!canSubmit}
                title="Send message (Enter)"
                aria-label="Send message"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

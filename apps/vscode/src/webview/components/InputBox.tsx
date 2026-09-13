import React, { useState, useRef, useEffect } from "react";

interface InputBoxProps {
  onSend: (prompt: string) => void;
  onAbort: () => void;
  isRunning: boolean;
  activeMode: string;
}

export const InputBox: React.FC<InputBoxProps> = ({
  onSend,
  onAbort,
  isRunning,
  activeMode,
}) => {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "38px";
    }
  };

  return (
    <div className="chat-footer">
      <div className="input-container">
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Ask Inflynx [${activeMode}]... (Enter to send, Shift+Enter for newline)`}
          rows={1}
          disabled={isRunning}
        />
        {isRunning ? (
          <button className="chat-send-btn abort-btn" onClick={onAbort} title="Stop turn">
            ■
          </button>
        ) : (
          <button
            className="chat-send-btn"
            onClick={handleSubmit}
            disabled={!text.trim()}
            title="Send prompt"
          >
            ➤
          </button>
        )}
      </div>
    </div>
  );
};

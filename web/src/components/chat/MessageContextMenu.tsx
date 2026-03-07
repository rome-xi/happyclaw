import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, FileText, Trash2 } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

interface MessageContextMenuProps {
  content: string;
  position: { x: number; y: number };
  onClose: () => void;
  chatJid?: string;
  messageId?: string;
}

export function MessageContextMenu({ content, position, onClose, chatJid, messageId }: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${position.y - rect.height - 8}px`;
    }
  }, [position]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    onClose();
  };

  const handleCopyText = () => {
    const plain = content
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/, '').replace(/\n?```$/, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    copyToClipboard(plain);
  };

  const handleCopyMarkdown = () => copyToClipboard(content);

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (chatJid && messageId) {
      await useChatStore.getState().deleteMessage(chatJid, messageId);
    }
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60]" onClick={onClose}>
      <div
        ref={menuRef}
        className="absolute bg-card rounded-xl shadow-lg border border-border py-1 min-w-[160px] animate-in zoom-in-95 fade-in duration-150"
        style={{ left: position.x, top: position.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleCopyText}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/50 active:bg-muted transition-colors"
        >
          <Copy className="w-4 h-4 text-slate-400" />
          复制文本
        </button>
        <div className="mx-3 border-t border-border" />
        <button
          onClick={handleCopyMarkdown}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted/50 active:bg-muted transition-colors"
        >
          <FileText className="w-4 h-4 text-slate-400" />
          复制 Markdown
        </button>
        {chatJid && messageId && (
          <>
            <div className="mx-3 border-t border-border" />
            <button
              onClick={handleDelete}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                confirmDelete
                  ? 'text-red-600 bg-red-50 hover:bg-red-100'
                  : 'text-red-500 hover:bg-muted/50 active:bg-muted'
              }`}
            >
              <Trash2 className="w-4 h-4" />
              {confirmDelete ? '确认删除' : '删除消息'}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

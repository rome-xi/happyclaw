import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Monitor,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DirectoryBrowser } from '../shared/DirectoryBrowser';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';

interface CreateContainerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (jid: string, folder: string) => void;
}

export function CreateContainerDialog({
  open,
  onClose,
  onCreated,
}: CreateContainerDialogProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customCwd, setCustomCwd] = useState('');

  const createFlow = useChatStore((s) => s.createFlow);
  const canHostExec = useAuthStore((s) => s.user?.role === 'admin');

  const reset = () => {
    setName('');
    setAdvancedOpen(false);
    setCustomCwd('');
  };

  const handleClose = () => {
    onClose();
    reset();
  };

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const options: Record<string, string> = { execution_mode: 'host' };
      if (canHostExec && customCwd.trim()) {
        options.custom_cwd = customCwd.trim();
      }
      const created = await createFlow(
        trimmed,
        Object.keys(options).length ? options : undefined,
      );
      if (created) {
        onCreated(created.jid, created.folder);
        handleClose();
      } else {
        toast.error('创建失败，请重试');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建工作区</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name input */}
          <div>
            <label className="block text-sm font-medium mb-2">工作区名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
              }}
              placeholder="输入工作区名称"
              autoFocus
            />
          </div>

          {/* Advanced options */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              {advancedOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              高级选项
            </button>
            {advancedOpen && (
              <div className="px-3 pb-3 space-y-3 border-t">
                {/* This personalized fork intentionally has one execution mode. */}
                <div className="pt-3">
                  <label className="block text-sm font-medium mb-2">
                    执行模式
                  </label>
                  <div className="flex items-start gap-3 p-2 rounded-lg border bg-accent/20">
                    <Monitor className="w-4 h-4 text-muted-foreground mt-0.5" />
                    <div>
                      <span className="text-sm font-medium">
                        宿主机模式（固定）
                      </span>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        所有工作区和 Agent 均直接在服务器上执行，不创建 Docker
                        容器。
                      </p>
                    </div>
                  </div>
                </div>

                {/* Only admins may point a workspace at an arbitrary host cwd. */}
                {canHostExec && (
                  <>
                    <DirectoryBrowser
                      value={customCwd}
                      onChange={setCustomCwd}
                      placeholder="默认: data/groups/{folder}/"
                    />
                    <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        宿主机模式下 Agent
                        可访问完整文件系统和工具链，请谨慎使用。
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={loading || !name.trim()}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? '正在创建...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

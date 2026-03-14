import { useState, useRef, useCallback } from 'react';
import {
  Bug,
  ImagePlus,
  X,
  Loader2,
  Copy,
  ExternalLink,
  CheckCircle2,
} from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { showToast } from '@/utils/toast';

interface BugReportDialogProps {
  open: boolean;
  onClose: () => void;
}

interface GenerateResult {
  title: string;
  body: string;
  systemInfo: Record<string, string>;
}

interface SubmitResult {
  method: 'created' | 'manual';
  url: string;
}

const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB

export function BugReportDialog({ open, onClose }: BugReportDialogProps) {
  // Step 1: Input
  const [description, setDescription] = useState('');
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [includeBrowserErrors, setIncludeBrowserErrors] = useState(false);

  // Step 2: Preview/Edit
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [systemInfo, setSystemInfo] = useState<Record<string, string>>({});

  // Step 3: Result
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  // State
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setDescription('');
    setScreenshots([]);
    setIncludeBrowserErrors(false);
    setTitle('');
    setBody('');
    setSystemInfo({});
    setSubmitResult(null);
    setStep(1);
    setLoading(false);
    setError(null);
    setCopied(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // --- Screenshot handling ---

  const addScreenshot = useCallback(
    (base64: string) => {
      if (screenshots.length >= MAX_SCREENSHOTS) {
        setError(`最多上传 ${MAX_SCREENSHOTS} 张截图`);
        return;
      }
      setScreenshots((prev) => [...prev, base64]);
      setError(null);
    },
    [screenshots.length],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_SCREENSHOT_SIZE) {
        setError('单张截图不能超过 5MB');
        return;
      }
      if (!file.type.startsWith('image/')) {
        setError('请选择图片文件');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Extract base64 part (remove data:image/...;base64, prefix)
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        addScreenshot(base64);
      };
      reader.readAsDataURL(file);
      // Reset input so same file can be selected again
      e.target.value = '';
    },
    [addScreenshot],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          if (file.size > MAX_SCREENSHOT_SIZE) {
            setError('粘贴的截图不能超过 5MB');
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            addScreenshot(base64);
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    },
    [addScreenshot],
  );

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // --- Step 1: Generate report ---

  const handleGenerate = useCallback(async () => {
    if (!description.trim()) {
      setError('请输入问题描述');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const result = await api.post<GenerateResult>(
        '/api/bug-report/generate',
        {
          description: description.trim(),
          screenshots: screenshots.length > 0 ? screenshots : undefined,
          browserErrors: includeBrowserErrors
            ? collectBrowserErrors()
            : undefined,
        },
        90000, // 90s timeout
      );
      setTitle(result.title);
      setBody(result.body);
      setSystemInfo(result.systemInfo);
      setStep(2);
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? (err as { message: string }).message
          : '生成报告失败，请重试';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [description, screenshots, includeBrowserErrors]);

  // --- Step 2: Submit issue ---

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !body.trim()) {
      setError('标题和内容不能为空');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const result = await api.post<SubmitResult>('/api/bug-report/submit', {
        title: title.trim(),
        body: body.trim(),
      });
      setSubmitResult(result);
      setStep(3);

      if (result.method === 'created') {
        showToast('Issue 创建成功', undefined, 8000, {
          text: '查看 Issue →',
          url: result.url,
        });
      } else {
        // Open pre-filled URL in new tab
        window.open(result.url, '_blank');
        showToast(
          '已打开 GitHub',
          '请在新标签页中登录并提交 Issue',
          6000,
        );
      }
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? (err as { message: string }).message
          : '提交失败，请重试';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [title, body]);

  const handleCopy = useCallback(async () => {
    const text = `# ${title}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      showToast('已复制到剪贴板');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('复制失败', '请手动选择文本复制');
    }
  }, [title, body]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="w-5 h-5" />
            {step === 1 && '报告问题'}
            {step === 2 && '预览 & 编辑'}
            {step === 3 && '提交结果'}
          </DialogTitle>
        </DialogHeader>

        {/* Error display */}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">
            {error}
          </div>
        )}

        {/* Step 1: Input */}
        {step === 1 && (
          <div className="space-y-4" onPaste={handlePaste}>
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">
                问题描述 <span className="text-red-500">*</span>
              </label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="请描述你遇到的问题..."
                rows={4}
                maxLength={5000}
              />
              <p className="text-xs text-slate-400 mt-1">
                {description.length}/5000
              </p>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">
                截图（可选，最多 {MAX_SCREENSHOTS} 张）
              </label>
              <div className="flex flex-wrap gap-2">
                {screenshots.map((_, i) => (
                  <div
                    key={i}
                    className="relative w-16 h-16 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center text-xs text-slate-500"
                  >
                    截图 {i + 1}
                    <button
                      type="button"
                      onClick={() => removeScreenshot(i)}
                      className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {screenshots.length < MAX_SCREENSHOTS && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-16 h-16 rounded-md border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 hover:border-teal-400 hover:text-teal-500 transition-colors"
                  >
                    <ImagePlus className="w-5 h-5" />
                    <span className="text-[10px] mt-0.5">添加</span>
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                支持粘贴截图或点击添加，单张不超过 5MB
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={includeBrowserErrors}
                onChange={(e) => setIncludeBrowserErrors(e.target.checked)}
                className="rounded"
              />
              附加浏览器控制台错误
            </label>
          </div>
        )}

        {/* Step 2: Preview/Edit */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">
                Issue 标题
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={256}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">
                Issue 内容（Markdown）
              </label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                className="font-mono text-xs"
              />
            </div>

            {Object.keys(systemInfo).length > 0 && (
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">
                  系统信息
                </p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(systemInfo).map(([k, v]) => (
                    <span
                      key={k}
                      className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded"
                    >
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Result */}
        {step === 3 && submitResult && (
          <div className="text-center py-6 space-y-4">
            <CheckCircle2 className="w-12 h-12 text-teal-500 mx-auto" />
            {submitResult.method === 'created' ? (
              <>
                <p className="text-lg font-medium text-slate-900">
                  Issue 创建成功！
                </p>
                <a
                  href={submitResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal-600 hover:text-teal-700 inline-flex items-center gap-1"
                >
                  查看 Issue <ExternalLink className="w-4 h-4" />
                </a>
              </>
            ) : (
              <>
                <p className="text-lg font-medium text-slate-900">
                  已在新标签页打开 GitHub
                </p>
                <p className="text-sm text-slate-500">
                  请在 GitHub 页面登录后提交 Issue
                </p>
                <a
                  href={submitResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal-600 hover:text-teal-700 inline-flex items-center gap-1 text-sm"
                >
                  重新打开 <ExternalLink className="w-3 h-3" />
                </a>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <DialogFooter>
          {step === 1 && (
            <>
              <Button variant="outline" onClick={handleClose}>
                取消
              </Button>
              <Button onClick={handleGenerate} disabled={loading}>
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {loading ? '分析中...' : '生成报告'}
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setStep(1);
                  setError(null);
                }}
              >
                返回
              </Button>
              <Button variant="outline" onClick={handleCopy}>
                <Copy className="w-4 h-4" />
                {copied ? '已复制' : '复制内容'}
              </Button>
              <Button onClick={handleSubmit} disabled={loading}>
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {loading ? '提交中...' : '提交 Issue'}
              </Button>
            </>
          )}
          {step === 3 && (
            <Button onClick={handleClose}>关闭</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Collect recent console errors from the browser */
function collectBrowserErrors(): string {
  // We can't retroactively read console history.
  // Return a placeholder message. In the future, this could be
  // enhanced with a console error interceptor.
  return '(浏览器控制台错误需手动复制)';
}

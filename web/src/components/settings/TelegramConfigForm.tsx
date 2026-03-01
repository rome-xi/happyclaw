import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { TelegramConfigPublic, TelegramTestResult, SettingsNotification } from './types';
import { getErrorMessage, sourceLabel } from './types';

interface TelegramConfigFormProps extends SettingsNotification {}

export function TelegramConfigForm({ setNotice, setError }: TelegramConfigFormProps) {
  const [config, setConfig] = useState<TelegramConfigPublic | null>(null);
  const [botToken, setBotToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<TelegramConfigPublic>('/api/config/telegram');
      setConfig(data);
      setBotToken('');
      setClearToken(false);
      setEnabled(data.enabled);
    } catch (err) {
      setError(getErrorMessage(err, '加载 Telegram 配置失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await api.put<TelegramConfigPublic>('/api/config/telegram', { enabled: newEnabled });
      setConfig(saved);
      setEnabled(saved.enabled);
      setNotice(`Telegram 渠道已${newEnabled ? '启用' : '停用'}${saved.connected ? '，已连接' : ''}`);

    } catch (err) {
      setError(getErrorMessage(err, '切换 Telegram 渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = { enabled };
      if (botToken.trim()) payload.botToken = botToken;
      if (!botToken.trim() && clearToken) payload.clearBotToken = true;

      const saved = await api.put<TelegramConfigPublic>('/api/config/telegram', payload);
      setConfig(saved);
      setBotToken('');
      setClearToken(false);
      setNotice(`Telegram 配置已保存并生效${saved.connected ? '，已连接' : ''}`);

    } catch (err) {
      setError(getErrorMessage(err, '保存 Telegram 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.post<TelegramTestResult>('/api/config/telegram/test');
      if (result.success) {
        setNotice(`Telegram 连接成功！Bot: @${result.bot_username} (${result.bot_name})`);
      } else {
        setError(result.error || 'Telegram 连接失败');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Telegram 连接测试失败'));
    } finally {
      setTesting(false);
    }
  };

  const formDisabled = !enabled;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* 卡片头部 */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Telegram</h3>
            <p className="text-xs text-slate-500 mt-0.5">通过 Telegram Bot 接收和回复消息</p>
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          disabled={loading || toggling}
          onClick={() => handleToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
            enabled ? 'bg-primary' : 'bg-slate-200'
          }`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>

      {/* 卡片内容 */}
      <div className={`px-5 py-4 space-y-4 transition-opacity ${formDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <div>
          <label className="block text-xs text-slate-600 mb-1">
            Bot Token {config?.hasBotToken ? `(${config.botTokenMasked})` : ''}
          </label>
          <Input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            disabled={loading || saving}
            placeholder={config?.hasBotToken ? '留空保持不变，输入新值覆盖' : '输入 Telegram Bot Token'}
          />
          <p className="mt-1 text-xs text-slate-400">在 Telegram 中搜索 @BotFather，发送 /newbot 创建机器人后获得</p>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={clearToken}
              onChange={(e) => setClearToken(e.target.checked)}
              disabled={saving}
            />
            清空现有 Token
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={loadConfig} disabled={loading || saving}>
            <RefreshCw className="w-4 h-4" />
            刷新
          </Button>
          <Button onClick={handleSave} disabled={loading || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存 Telegram 配置
          </Button>
          <Button variant="outline" onClick={handleTest} disabled={loading || testing || !config?.hasBotToken}>
            {testing && <Loader2 className="size-4 animate-spin" />}
            测试连接
          </Button>
        </div>

        <div className="text-xs text-slate-500 space-y-1">
          <div>当前来源：{sourceLabel(config?.source || 'none')}</div>
          <div>最近保存：{config?.updatedAt ? new Date(config.updatedAt).toLocaleString('zh-CN') : '未记录'}</div>
        </div>
      </div>
    </div>
  );
}

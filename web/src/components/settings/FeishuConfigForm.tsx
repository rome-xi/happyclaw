import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { FeishuConfigPublic, SettingsNotification } from './types';
import { getErrorMessage, sourceLabel } from './types';

interface FeishuConfigFormProps extends SettingsNotification {}

export function FeishuConfigForm({ setNotice, setError }: FeishuConfigFormProps) {
  const [config, setConfig] = useState<FeishuConfigPublic | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<FeishuConfigPublic>('/api/config/feishu');
      setConfig(data);
      setAppId(data.appId || '');
      setAppSecret('');
      setClearSecret(false);
      setEnabled(data.enabled);
    } catch (err) {
      setError(getErrorMessage(err, '加载飞书配置失败'));
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
      const saved = await api.put<FeishuConfigPublic>('/api/config/feishu', { enabled: newEnabled });
      setConfig(saved);
      setEnabled(saved.enabled);
      setNotice(`飞书渠道已${newEnabled ? '启用' : '停用'}${saved.connected ? '，已连接' : ''}`);

    } catch (err) {
      setError(getErrorMessage(err, '切换飞书渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = { appId, enabled };
      if (appSecret.trim()) payload.appSecret = appSecret;
      if (!appSecret.trim() && clearSecret) payload.clearAppSecret = true;

      const saved = await api.put<FeishuConfigPublic>('/api/config/feishu', payload);
      setConfig(saved);
      setAppSecret('');
      setClearSecret(false);
      setNotice(`飞书配置已保存并生效${saved.connected ? '，已连接' : ''}`);

    } catch (err) {
      setError(getErrorMessage(err, '保存飞书配置失败'));
    } finally {
      setSaving(false);
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
            <h3 className="text-sm font-semibold text-slate-800">飞书 Feishu</h3>
            <p className="text-xs text-slate-500 mt-0.5">接收飞书群消息并通过 Agent 自动回复</p>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-slate-600 mb-1">App ID</label>
            <Input
              type="text"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              disabled={loading || saving}
              placeholder="cli_xxx"
            />
            <p className="mt-1 text-xs text-slate-400">在飞书开放平台 → 应用管理 → 凭证与基础信息中获取</p>
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">
              App Secret {config?.hasAppSecret ? `(${config.appSecretMasked})` : ''}
            </label>
            <Input
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              disabled={loading || saving}
              placeholder={config?.hasAppSecret ? '留空保持不变，输入新值覆盖' : '输入飞书 App Secret'}
            />
            <p className="mt-1 text-xs text-slate-400">应用密钥，与 App ID 在同一页面获取</p>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={clearSecret}
                onChange={(e) => setClearSecret(e.target.checked)}
                disabled={saving}
              />
              清空现有 Secret
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={loadConfig} disabled={loading || saving}>
            <RefreshCw className="w-4 h-4" />
            刷新
          </Button>
          <Button onClick={handleSave} disabled={loading || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存飞书配置
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

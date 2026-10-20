(function () {
  'use strict';
  window.__ModuleLoader__.load({
    id: 'dsh-feiyu-memory',
    factory(require) {
      const React = require('react');
      const h = React.createElement;
      const API = 'api/feiyu-memory/backup/';
      const DEFAULT_TRANSFER_LIMIT = 512 * 1024 * 1024;
      const ERROR_TEXT = {
        BACKUP_TARGET: '请选择新建或空文件夹，现有记忆不会被覆盖。',
        BACKUP_IDENTITY: '记忆身份不匹配，请核对所选备份或更换备份目录。',
        BACKUP_FORMAT: '这个文件不是可用的记忆备份，请重新选择。',
        BACKUP_HASH: '备份文件校验失败，请重新选择一份完整备份。',
        BACKUP_INTEGRITY: '备份内容未通过检查，请使用另一份备份。',
        BACKUP_FOREIGN_KEY: '备份内容未通过检查，请使用另一份备份。',
        BACKUP_RECORD: '备份内容未通过检查，请使用另一份备份。',
        BACKUP_SCHEMA: '当前版本无法读取这份备份，请核对插件版本。',
        BACKUP_RESTORE: '这份备份未通过恢复检查，请使用另一份备份。',
        BACKUP_PATH: '请选择本设备可访问的完整路径，备份目录须在当前记忆目录之外。',
        BACKUP_LINK: '所选位置含链接或目录联接，请选择实际文件夹。',
        BACKUP_SOURCE: '当前记忆暂不可用，请检查插件是否正常运行。',
        BACKUP_CONFLICT: '目标文件已改变，请刷新后重试。',
        BACKUP_MEMORY_LIMIT: '当前设备内存不足，未能完成验证。请关闭其他应用后重试，或换设备处理。',
        BACKUP_SIZE: '这份记忆超出了当前支持的大小。',
        BACKUP_BUSY: '已有操作正在进行，请等待完成。',
        BUSY: '已有操作正在进行，请等待完成。',
        ENOSPC: '空间不足，请换目录或腾出空间后重试。',
        ENOENT: '所选文件或目录暂不可用，请检查路径或磁盘连接。',
        EACCES: '无法访问所选位置，请选择本应用可读写的目录。',
        EPERM: '无法访问所选位置，请检查权限或文件是否被占用。',
        EEXIST: '这个文件已经存在，请换一个文件名。',
        BACKUP_CHANGED: '备份文件已经改变，请重新验证后恢复。',
        BACKUP_VERIFY_CHANGED: '备份文件已经改变，请重新验证后恢复。',
        BACKUP_LIMIT: '文件过大，请改用本设备文件路径处理。',
        UPLOAD_LIMIT: '文件过大，请改用本设备文件路径处理。',
        DOWNLOAD_LIMIT: '文件过大，请保存到本设备文件夹。',
        FORBIDDEN: '当前连接无权管理备份，请从自己的 DSH 设置页打开。',
        UNAUTHORIZED: '连接已失效，请重新打开 DSH 后再试。',
      };

      function friendlyError(error) {
        const code = typeof error?.code === 'string' ? error.code : '';
        if (ERROR_TEXT[code]) return ERROR_TEXT[code];
        const message = typeof error?.message === 'string' ? error.message : '';
        if (/[\u3400-\u9fff]/u.test(message)) return message.slice(0, 300);
        return '操作未能确认完成，请刷新状态后重试。需要时可查看错误代码。';
      }
      function fail(message) { const error = new Error(message); error.code = 'INPUT'; throw error; }
      function absolute(value, label) {
        const result = String(value || '').trim();
        if (!result || /[\u0000-\u001f]/u.test(result)
          || !/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/u.test(result)) fail(`${label}需要完整路径；也可以点击“选择”浏览本设备。`);
        return result;
      }
      function settingsInput(form) {
        const backupDir = form.backupDir.trim();
        if (backupDir) absolute(backupDir, '备份目录');
        if (form.enabled && !backupDir) fail('请先选择备份目录，再开启自动备份。');
        if (!['interval', 'monthly'].includes(form.schedule)) fail('请选择备份周期。');
        if (form.schedule === 'interval' && (!/^\d+$/u.test(String(form.intervalDays))
          || Number(form.intervalDays) < 1 || Number(form.intervalDays) > 30)) fail('间隔天数必须为 1～30 的整数。');
        return { enabled: Boolean(form.enabled), backupDir, schedule: form.schedule,
          intervalDays: form.schedule === 'monthly' ? 1 : Number(form.intervalDays) };
      }
      function safeName(value) {
        let name = String(value || '').trim();
        if (!name) return undefined;
        if (/[\\/\u0000-\u001f<>:"|?*]/u.test(name) || name.startsWith('.')) fail('文件名不能以点开头，也不能包含路径分隔符或特殊字符。');
        if (!name.toLowerCase().endsWith('.feiyu-backup')) name += '.feiyu-backup';
        else name = name.slice(0, -'.feiyu-backup'.length) + '.feiyu-backup';
        if (name.toLowerCase() === 'latest.feiyu-backup') fail('导出副本请另取文件名，不能使用 latest。');
        if (name.length > 180) fail('文件名过长，请缩短后重试。');
        return name;
      }
      function readableTime(value, timeZone, empty = '时间未知') {
        if (!value || !Number.isFinite(Date.parse(value))) return empty;
        try { return new Intl.DateTimeFormat('zh-CN', { timeZone: timeZone || undefined, year: 'numeric',
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)); }
        catch { return new Date(value).toLocaleString(); }
      }
      function sizeText(value) {
        if (!Number.isFinite(value)) return '';
        return value < 1024 * 1024 ? `${Math.max(1, Math.ceil(value / 1024))} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
      }
      async function api(name, body, extra = {}) {
        let response;
        try {
          response = await fetch(API + name, {
            method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...extra,
          });
        } catch { throw Object.assign(new Error('连接暂不可用，请确认 DSH 正在运行后重试。'), { code: 'NETWORK' }); }
        let envelope;
        try { envelope = await response.json(); } catch { throw Object.assign(new Error('未收到有效结果，请刷新状态后重试。'), { code: 'RESPONSE' }); }
        if (!response.ok || envelope?.ok !== true) {
          const problem = envelope?.error || {};
          throw Object.assign(new Error(typeof problem.message === 'string' ? problem.message : '操作失败'), {
            code: typeof problem.code === 'string' ? problem.code : `HTTP_${response.status}`,
          });
        }
        return envelope.data;
      }

      const CSS = `
.feiyu-backup-page{--fy-border:var(--dsw-alias-border-primary,rgba(128,128,128,.26));--fy-muted:var(--dsw-alias-label-secondary,#68707a);--fy-panel:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.055));color:var(--dsw-alias-label-primary,inherit);font:inherit;line-height:1.6;min-width:0;width:100%;box-sizing:border-box;padding:4px 0 28px}
.feiyu-backup-page *{box-sizing:border-box}.feiyu-backup-page h2{font-size:1.3em;line-height:1.4;margin:0 0 8px}.feiyu-backup-page h3{font-size:1.06em;margin:0 0 12px}.feiyu-backup-page p{margin:6px 0 12px}.feiyu-backup-page .fy-muted{color:var(--fy-muted);font-size:.9em}.feiyu-backup-page .fy-card{background:var(--fy-panel);border:1px solid var(--fy-border);border-radius:var(--dsw-radius-md,10px);padding:16px;margin:14px 0;min-width:0}
.feiyu-backup-page label{display:block;margin:10px 0 5px}.feiyu-backup-page input:not([type=checkbox]):not([type=file]),.feiyu-backup-page select{width:100%;min-width:0;border:1px solid var(--fy-border);background:var(--dsw-alias-bg-base,transparent);color:inherit;border-radius:7px;padding:9px 10px;font:inherit}.feiyu-backup-page input[type=file]{max-width:100%;font:inherit}.feiyu-backup-page input[type=checkbox]{accent-color:#5287db;margin:0 8px 0 0}
.feiyu-backup-page .fy-row{display:flex;gap:8px;align-items:center;min-width:0}.feiyu-backup-page .fy-row>input{flex:1}.feiyu-backup-page .fy-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.feiyu-backup-page button{font:inherit;line-height:1.4;border:1px solid var(--fy-border);border-radius:7px;padding:9px 13px;color:inherit;background:transparent;cursor:pointer;min-height:40px}.feiyu-backup-page button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}.feiyu-backup-page button.fy-primary{background:#3468bd;color:#fff;border-color:#3468bd}.feiyu-backup-page button:disabled{opacity:.5;cursor:not-allowed}.feiyu-backup-page :focus-visible{outline:2px solid #6699ed;outline-offset:2px}
.feiyu-backup-page .fy-message{padding:12px;border-radius:8px;border:1px solid var(--fy-border);white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}.feiyu-backup-page .fy-error{border-color:#bd6868;background:rgba(190,70,70,.07)}.feiyu-backup-page .fy-success{border-color:#4f986f;background:rgba(50,150,90,.06)}.feiyu-backup-page .fy-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px}.feiyu-backup-page .fy-value{overflow-wrap:anywhere;white-space:pre-wrap}.feiyu-backup-page details{margin:8px 0}.feiyu-backup-page summary{cursor:pointer}.feiyu-backup-page .fy-picker-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);padding:12px}.feiyu-backup-page .fy-picker{border:2px solid #6486ba;background:var(--dsw-alias-bg-layer-2,#fff);width:min(580px,100%);max-height:calc(100dvh - 24px);overflow:auto;margin:0}.feiyu-backup-page .fy-file-list{max-height:260px;overflow:auto;margin-top:10px;display:grid;gap:4px}.feiyu-backup-page .fy-file-list button{text-align:left;overflow-wrap:anywhere;white-space:normal}.feiyu-backup-page .fy-nowrap{white-space:nowrap}.feiyu-backup-page .fy-divider{border-top:1px solid var(--fy-border);padding-top:12px;margin-top:16px}
@media(max-width:560px){.feiyu-backup-page .fy-grid{grid-template-columns:1fr}.feiyu-backup-page .fy-card{padding:12px}.feiyu-backup-page .fy-actions>button{flex:1 1 145px}.feiyu-backup-page .fy-row>button{padding-left:10px;padding-right:10px}.feiyu-backup-page .fy-picker .fy-actions>button{flex-basis:120px}}
@media(prefers-color-scheme:dark){.feiyu-backup-page{--fy-muted:var(--dsw-alias-label-secondary,#a7adb6)}.feiyu-backup-page .fy-picker{background:var(--dsw-alias-bg-layer-2,#22272e)}}
`;

      function BackupPage() {
        const [model, setModel] = React.useState(null);
        const [form, setForm] = React.useState({ enabled: false, backupDir: '', schedule: 'interval', intervalDays: '1' });
        const [dirty, setDirty] = React.useState(false);
        const [busy, setBusy] = React.useState('');
        const [error, setError] = React.useState(null);
        const [notice, setNotice] = React.useState('');
        const [exportDir, setExportDir] = React.useState('');
        const [exportName, setExportName] = React.useState('');
        const [source, setSource] = React.useState('');
        const [uploadName, setUploadName] = React.useState('');
        const [verification, setVerification] = React.useState(null);
        const [restoreDir, setRestoreDir] = React.useState('');
        const [restored, setRestored] = React.useState(null);
        const [picker, setPicker] = React.useState(null);
        const [pickerPath, setPickerPath] = React.useState('');
        const [newFolder, setNewFolder] = React.useState('');
        const actionLock = React.useRef(false);
        const alive = React.useRef(true);
        const pickerSequence = React.useRef(0);
        const pickerOpener = React.useRef(null);
        const controlsDisabled = Boolean(busy || model?.busy);
        const scheduler = model?.scheduler || model?.status || {};
        const uploadLimit = model?.capabilities?.uploadMaxBytes ?? DEFAULT_TRANSFER_LIMIT;
        const downloadLimit = model?.capabilities?.downloadMaxBytes ?? DEFAULT_TRANSFER_LIMIT;

        async function refresh(syncForm = false) {
          const value = await api('status');
          if (!alive.current) return;
          setModel(value);
          if (syncForm) {
            const settings = value.settings || {};
            setForm({ enabled: Boolean(settings.enabled), backupDir: settings.backupDir || '',
              schedule: settings.schedule || 'interval', intervalDays: String(settings.intervalDays ?? 1) });
            setDirty(false);
            setExportDir(current => current || settings.backupDir || '');
          }
          setRestoreDir(current => current || (value.dataDir ? `${value.dataDir.replace(/[\\/]+$/u, '')}-restored-${new Date().toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14)}` : ''));
        }
        React.useEffect(() => {
          alive.current = true;
          refresh(true).catch(problem => { if (alive.current) setError(problem); });
          return () => { alive.current = false; pickerSequence.current++; };
        }, []);
        React.useEffect(() => {
          if (!busy && !model?.busy) return undefined;
          const timer = setInterval(() => { refresh(false).catch(() => {}); }, 1500);
          return () => clearInterval(timer);
        }, [busy, Boolean(model?.busy)]);

        async function act(label, operation, { syncForm = false } = {}) {
          if (actionLock.current || model?.busy) return;
          actionLock.current = true;
          setBusy(label); setError(null); setNotice('');
          let succeeded = false;
          try {
            await operation();
            succeeded = true;
          } catch (problem) { if (alive.current) setError(problem); }
          finally {
            try { await refresh(succeeded && syncForm || !model); }
            catch { if (alive.current) setNotice(current => `${current ? current + '\n' : ''}状态暂未刷新，可稍后点击“刷新状态”。`); }
            actionLock.current = false; if (alive.current) setBusy('');
          }
        }
        function updateForm(key, value) { setDirty(true); setForm(current => ({ ...current, [key]: value })); }
        function updateSource(value) { setSource(value); setUploadName(''); setVerification(null); setRestored(null); }
        function updateRestoreDir(value) { setRestoreDir(value); setRestored(null); }
        async function browse(target, directory) {
          const sequence = ++pickerSequence.current;
          const type = target === 'source' ? 'file' : 'directory';
          setPicker({ target, type, loading: true, error: null });
          try {
            const value = await api('browse', { ...(directory?.trim() ? { path: directory.trim() } : {}), kind: type });
            if (!alive.current || sequence !== pickerSequence.current) return;
            setPicker({ ...value, target, type, loading: false });
            setPickerPath(value.path || '');
          } catch (problem) {
            if (alive.current && sequence === pickerSequence.current) setPicker(current => ({ ...current, loading: false, error: problem }));
          }
        }
        function openPicker(target, directory) {
          pickerOpener.current = document.activeElement;
          setNewFolder(''); setPickerPath(directory || ''); browse(target, directory);
        }
        function closePicker() { pickerSequence.current++; setPicker(null); pickerOpener.current?.focus?.(); }
        function choosePath(selected) {
          if (picker.target === 'source') updateSource(selected);
          if (picker.target === 'backup') updateForm('backupDir', selected);
          if (picker.target === 'export') setExportDir(selected);
          if (picker.target === 'restore') updateRestoreDir(selected);
          closePicker();
        }
        function selectDirectory() {
          try {
            let selected = absolute(picker.path, '目录');
            if (newFolder.trim()) {
              const name = newFolder.trim();
              if (/[\\/\u0000-\u001f<>:"|?*]/u.test(name) || /^\.+$/u.test(name)) fail('新文件夹名称不能包含路径分隔符或特殊字符。');
              selected = selected.replace(/[\\/]+$/u, '') + '/' + name;
            }
            choosePath(selected);
          } catch (problem) { setPicker(current => ({ ...current, error: problem })); }
        }
        function pathControl(id, label, value, change, target, description) {
          return h('div', null, h('label', { htmlFor: id }, label),
            h('div', { className: 'fy-row' },
              h('input', { id, type: 'text', value, onChange: event => change(event.target.value),
                disabled: controlsDisabled, autoComplete: 'off', spellCheck: false, placeholder: '选择文件夹，或粘贴完整路径' }),
              h('button', { type: 'button', className: 'fy-nowrap', disabled: controlsDisabled,
                onClick: () => openPicker(target, value) }, '选择')),
            description ? h('div', { className: 'fy-muted' }, description) : null);
        }
        function errorView(problem) {
          return problem ? h('div', { className: 'fy-message fy-error', role: 'alert' },
            friendlyError(problem), problem.code && problem.code !== 'INPUT' ? h('details', null,
              h('summary', null, '错误代码'), h('span', { className: 'fy-muted' }, String(problem.code).slice(0, 100))) : null) : null;
        }
        async function upload(event) {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          await act('正在接收备份文件…', async () => {
            if (!file.name.toLowerCase().endsWith('.feiyu-backup')) fail('请选择 .feiyu-backup 记忆备份文件。');
            if (file.size > uploadLimit) fail(`文件选择最多支持 ${sizeText(uploadLimit)}；更大文件请使用本设备文件路径。`);
            const value = await api('upload', file, { method: 'POST', headers: {
              'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name),
            }, body: file });
            if (!alive.current) return;
            setSource(value.file); setUploadName(value.fileName || file.name); setVerification(null); setRestored(null);
            setNotice('文件已选入。请先验证，再恢复到新目录。');
          });
        }
        async function downloadCopy() {
          await act('正在生成并检查下载副本…', async () => {
            const value = await api('export', { download: true });
            if (!value.downloadId) fail('未取得下载入口，请改为保存到本设备文件夹。');
            if (value.bytes > downloadLimit) fail(`下载副本最多支持 ${sizeText(downloadLimit)}；请改为保存到本设备文件夹。`);
            const response = await fetch(API + 'download?id=' + encodeURIComponent(value.downloadId), { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) {
              let result;
              try { result = await response.json(); } catch {}
              throw Object.assign(new Error(result?.error?.message || '下载未完成，请改为保存到本设备文件夹。'), { code: result?.error?.code || 'DOWNLOAD' });
            }
            const length = Number(response.headers.get('Content-Length'));
            if (Number.isFinite(length) && length > downloadLimit) fail('下载文件超过当前限制，请改为保存到本设备文件夹。');
            const blob = await response.blob();
            if (blob.size > downloadLimit) fail('下载文件超过当前限制，请改为保存到本设备文件夹。');
            if (!alive.current) return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = String(value.fileName || 'feiyu-memory.feiyu-backup').split(/[\\/]/u).pop();
            link.style.display = 'none'; document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            setNotice('已将副本交给浏览器／系统保存，请确认文件出现在下载位置。若手机没有保存提示，请改用“保存到文件夹”。');
          });
        }

        const latestError = model?.lastError || scheduler.lastError || model?.settingsError;
        const manifest = verification?.manifest;
        const otherIdentity = manifest?.identity?.instanceId && model?.instanceId && manifest.identity.instanceId !== model.instanceId;
        const pickerView = picker ? h('div', { className: 'fy-picker-overlay', onClick: event => {
          if (event.target === event.currentTarget) closePicker();
        } }, h('section', { className: 'fy-card fy-picker', role: 'dialog', 'aria-modal': true,
          'aria-label': picker.type === 'file' ? '选择备份文件' : '选择文件夹',
          onKeyDown: event => {
            if (event.key === 'Escape') { event.preventDefault(); closePicker(); }
            if (event.key === 'Tab') {
              const items = [...event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')];
              if (items.length && event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
              else if (items.length && !event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
            }
          } },
          h('h3', null, picker.type === 'file' ? '浏览本设备的备份文件' : '浏览本设备的文件夹'),
          h('p', { className: 'fy-muted' }, '这里列出 DSH 所在设备可访问的位置。也可以粘贴路径，手机受应用访问权限限制。'),
          h('div', { className: 'fy-row' }, h('input', { 'aria-label': '浏览路径', value: pickerPath,
            onChange: event => setPickerPath(event.target.value), disabled: picker.loading, spellCheck: false }),
            h('button', { type: 'button', disabled: picker.loading, onClick: () => browse(picker.target, pickerPath) }, '打开')),
          errorView(picker.error),
          picker.loading ? h('p', { role: 'status' }, '正在读取文件夹…') : null,
          h('div', { className: 'fy-actions' },
            h('button', { type: 'button', disabled: picker.loading || !picker.parent, onClick: () => browse(picker.target, picker.parent) }, '上一级'),
            h('button', { type: 'button', disabled: picker.loading, onClick: () => browse(picker.target) }, '可用位置'),
            h('button', { type: 'button', autoFocus: true, onClick: closePicker }, '取消')),
          h('div', { className: 'fy-file-list' },
            ...(picker.roots || []).map((entry, index) => h('button', { type: 'button', key: 'root-' + index, disabled: picker.loading,
              onClick: () => browse(picker.target, entry.path) }, '▣ ' + (entry.name || entry.path))),
            ...(picker.entries || []).map((entry, index) => h('button', { type: 'button', key: 'entry-' + index, disabled: picker.loading,
              onClick: () => entry.type === 'directory' ? browse(picker.target, entry.path) : choosePath(entry.path) },
              (entry.type === 'directory' ? '▸ ' : '▤ ') + entry.name)),
            !picker.loading && !picker.entries?.length && !picker.roots?.length ? h('span', { className: 'fy-muted' }, '没有可选择的项目。') : null),
          picker.truncated ? h('p', { className: 'fy-muted' }, '项目较多，仅显示部分；可输入更具体的目录。') : null,
          picker.type === 'directory' ? h('div', null,
            h('label', { htmlFor: 'fy-new-folder' }, '新子文件夹（可选）'),
            h('input', { id: 'fy-new-folder', value: newFolder, onChange: event => setNewFolder(event.target.value),
              placeholder: '留空则使用当前文件夹', disabled: picker.loading }),
            h('p', { className: 'fy-muted' }, '选择只填入路径，执行保存或恢复时才会创建新文件夹。'),
            h('button', { type: 'button', className: 'fy-primary', disabled: picker.loading || !picker.path, onClick: selectDirectory }, '使用此位置')) : null)) : null;

        return h('div', { className: 'feiyu-backup-page' },
          h('style', null, CSS),
          h('h2', null, '肥鱼记忆备份'),
          h('p', null, '保存肥鱼记忆，或从备份恢复到新目录。备份不包含 DSH 聊天列表、图片附件和模型设置。'),
          h('p', { className: 'fy-muted' }, '备份文件未加密，请保存在你信任的位置。Windows 与 Android 的记忆各自独立。'),
          errorView(error),
          notice ? h('div', { className: 'fy-message fy-success', role: 'status' }, notice) : null,
          controlsDisabled ? h('div', { className: 'fy-message', role: 'status', 'aria-live': 'polite' },
            busy || '已有备份操作正在进行…', h('div', { className: 'fy-muted' }, '不要重复点击。离开页面不会撤销已经开始的操作。')) : null,
          !model && !error ? h('p', { role: 'status' }, '正在读取备份设置…') : null,
          h('section', { className: 'fy-card', 'aria-label': '备份状态' },
            h('div', { className: 'fy-grid' },
              h('div', null, h('div', { className: 'fy-muted' }, '上次成功'), h('div', null, readableTime(scheduler.lastSuccessAt, model?.timezone, '尚无成功备份'))),
              h('div', null, h('div', { className: 'fy-muted' }, '自动备份'),
                h('div', null, model?.settings?.enabled ? '已开启' : '关闭'),
                model?.settings?.enabled && scheduler.nextDueAt ? h('div', { className: 'fy-muted' }, '下次到期：' + readableTime(scheduler.nextDueAt, model?.timezone)) : null)),
            latestError ? h('div', { className: 'fy-message fy-error' }, '最近一次问题：' + friendlyError(latestError),
              latestError.at ? h('div', { className: 'fy-muted' }, readableTime(latestError.at, model?.timezone)) : null) : null,
            model?.settingsWarning ? h('div', { className: 'fy-message' }, '设置已生效，但保存确认未完全完成。请刷新并检查当前设置；不要反复切换。') : null,
            model?.lastOperation?.completion === 'unconfirmed' ? h('div', { className: 'fy-message' },
              '上次操作未能确认完成。文件可能已经生成；请先验证目标文件，不要直接假定操作没有执行。') : null,
            h('div', { className: 'fy-actions' }, h('button', { type: 'button', disabled: controlsDisabled, onClick: () => act('正在刷新状态…', async () => {}) }, '刷新状态')),
            h('details', null, h('summary', null, '当前记忆位置'),
              h('div', { className: 'fy-muted fy-value' }, model ? `${model.instanceId || ''}\n${model.dataDir || ''}\n${model.timezone || ''}` : '尚未读取'))),
          h('section', { className: 'fy-card', 'aria-label': '自动备份设置' },
            h('h3', null, '自动备份'),
            h('label', null, h('input', { type: 'checkbox', checked: form.enabled, disabled: controlsDisabled || !model,
              onChange: event => updateForm('enabled', event.target.checked) }), '开启自动备份'),
            pathControl('fy-backup-dir', '备份文件夹', form.backupDir, value => updateForm('backupDir', value), 'backup', '只保留一份最新备份；可选择其他磁盘。不要放在当前记忆目录内。'),
            h('div', { className: 'fy-grid' }, h('div', null, h('label', { htmlFor: 'fy-schedule' }, '备份周期'),
              h('select', { id: 'fy-schedule', value: form.schedule, disabled: controlsDisabled,
                onChange: event => updateForm('schedule', event.target.value) },
                h('option', { value: 'interval' }, '每隔若干天'), h('option', { value: 'monthly' }, '每个自然月'))),
              form.schedule === 'interval' ? h('div', null, h('label', { htmlFor: 'fy-interval' }, '间隔天数（1～30）'),
                h('input', { id: 'fy-interval', type: 'number', min: 1, max: 30, step: 1, inputMode: 'numeric', value: form.intervalDays,
                  disabled: controlsDisabled, onChange: event => updateForm('intervalDays', event.target.value) })) : null),
            h('p', { className: 'fy-muted' }, form.schedule === 'monthly' ? '按当前记忆时区计算自然月；应用运行时检查，应用关闭时不执行。' : '从上次成功起计算间隔；应用运行时检查，应用关闭时不执行。'),
            h('div', { className: 'fy-actions' },
              h('button', { type: 'button', className: 'fy-primary', disabled: controlsDisabled || !model, onClick: () => act('正在保存设置…', async () => {
                await api('settings', settingsInput(form)); if (alive.current) setNotice('备份设置已保存。');
              }, { syncForm: true }) }, '保存设置'),
              h('button', { type: 'button', disabled: controlsDisabled || !model, onClick: () => act('正在生成并检查最新备份…', async () => {
                if (dirty) fail('请先保存设置，再立即备份。');
                if (!model.settings?.backupDir) fail('请先选择备份目录并保存设置。');
                await api('now', {}); if (alive.current) setNotice('最新备份已生成并通过检查。');
              }) }, '立即备份')),
            dirty ? h('div', { className: 'fy-muted' }, '有尚未保存的设置。') : null,
            h('div', { className: 'fy-muted' }, '关闭自动备份后，仍可手动立即备份。自动备份不保留多个历史版本。')),
          pickerView,
          h('section', { className: 'fy-card', 'aria-label': '导出独立副本' },
            h('h3', null, '导出独立副本'),
            h('p', { className: 'fy-muted' }, '另存一个文件，方便迁移或单独保留。不会覆盖已经存在的导出。大文件优先保存到本设备文件夹。'),
            pathControl('fy-export-dir', '保存文件夹', exportDir, setExportDir, 'export'),
            h('label', { htmlFor: 'fy-export-name' }, '文件名（可选）'),
            h('input', { id: 'fy-export-name', value: exportName, placeholder: '留空则按时间命名', disabled: controlsDisabled,
              onChange: event => setExportName(event.target.value), spellCheck: false }),
            h('div', { className: 'fy-actions' },
              h('button', { type: 'button', disabled: controlsDisabled || !model, onClick: () => act('正在生成并检查导出副本…', async () => {
                const directory = absolute(exportDir, '保存文件夹'), fileName = safeName(exportName);
                const value = await api('export', { directory, ...(fileName ? { fileName } : {}) });
                if (alive.current) setNotice(`导出完成，文件已通过检查。\n${value.file || value.path || directory}`);
              }) }, '保存到文件夹'),
              h('button', { type: 'button', disabled: controlsDisabled || !model, onClick: downloadCopy }, '下载副本')),
            h('p', { className: 'fy-muted' }, `浏览器下载最多支持 ${sizeText(downloadLimit)}；手机是否弹出保存提示取决于宿主。`)),
          h('section', { className: 'fy-card', 'aria-label': '从备份恢复' },
            h('h3', null, '从备份恢复'),
            h('p', null, '先验证备份，再恢复到新建或空文件夹。不会覆盖、合并或切换当前记忆。'),
            h('label', { htmlFor: 'fy-import-file' }, '从电脑或手机选择备份文件'),
            h('input', { id: 'fy-import-file', type: 'file', accept: '.feiyu-backup', onChange: upload, disabled: controlsDisabled }),
            h('div', { className: 'fy-muted' }, `文件选择最多支持 ${sizeText(uploadLimit)}。更大文件可直接使用下方的本设备路径。`),
            h('label', { htmlFor: 'fy-source' }, '或使用 DSH 所在设备的文件路径'),
            h('div', { className: 'fy-row' },
              h('input', { id: 'fy-source', value: source.startsWith('upload:') ? uploadName : source,
                readOnly: source.startsWith('upload:'), onChange: event => updateSource(event.target.value), disabled: controlsDisabled,
                placeholder: '完整的 .feiyu-backup 文件路径', spellCheck: false, autoComplete: 'off' }),
              h('button', { type: 'button', disabled: controlsDisabled, onClick: () => openPicker('source', '') }, '浏览')),
            source.startsWith('upload:') ? h('button', { type: 'button', disabled: controlsDisabled, onClick: () => updateSource('') }, '清除所选文件') : null,
            h('div', { className: 'fy-actions' }, h('button', { type: 'button', disabled: controlsDisabled || !source || !model,
              onClick: () => act('正在验证备份…', async () => {
                const file = source.startsWith('upload:') ? source : absolute(source, '备份文件');
                setVerification(null); setRestored(null);
                const value = await api('verify', { file });
                if (value.validated !== true || !/^[a-f0-9]{64}$/iu.test(value.sha256 || '')
                  || typeof value.manifest?.identity?.instanceId !== 'string' || !value.manifest.identity.instanceId) fail('未取得完整验证结果，请重新验证。');
                if (alive.current) { setVerification({ ...value, file }); setNotice('备份已通过检查。请选择恢复目录。'); }
              }) }, '验证备份')),
            verification ? h('div', { className: 'fy-divider' },
              h('h3', null, '确认恢复内容'),
              h('div', null, '备份时间：' + readableTime(manifest?.createdAt, model?.timezone)),
              h('div', { className: 'fy-value' }, '记忆身份：' + (manifest?.identity?.instanceId || '未知')),
              h('div', { className: 'fy-muted' }, '记忆时区：' + (manifest?.identity?.timezone || '未知')),
              otherIdentity ? h('p', { className: 'fy-message' }, '这是另一份记忆。恢复会保留它的原身份，不会与当前记忆合并。') : null,
              h('p', { className: 'fy-muted' }, '恢复到这个快照的状态；之后新增、更正或删除的内容不会自动合并进来，原保留期限也不会重新开始。'),
              pathControl('fy-restore-dir', '恢复目录（必须新建或为空）', restoreDir, updateRestoreDir, 'restore'),
              h('div', { className: 'fy-actions' }, h('button', { type: 'button', className: 'fy-primary',
                disabled: controlsDisabled || !restoreDir || Boolean(restored), onClick: () => act('正在恢复到新目录…', async () => {
                  const targetDir = absolute(restoreDir, '恢复目录');
                  const value = await api('restore', { file: verification.file, targetDir, expectedSha256: verification.sha256,
                    expectedInstanceId: verification.manifest.identity.instanceId });
                  if (alive.current) { setRestored(value); setNotice('恢复完成，当前仍在使用原记忆，没有自动切换。'); }
                }) }, '确认恢复到新目录'))) : null,
            restored ? h('div', { className: 'fy-message fy-success', role: 'status' },
              '已恢复到：', h('div', { className: 'fy-value' }, restored.targetDir || restoreDir),
              h('p', null, '当前记忆仍未切换。'),
              h('details', null, h('summary', null, '如何使用恢复结果'),
                h('p', null, '使用恢复结果需要把插件的记忆目录设为这个新目录，保留备份的身份与时区，再正常启动插件。届时会重建派生文件并按原时间维护。当前页面不会修改这一配置。'))) : null));
      }
      return {
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'feiyu-memory-backup', order: 60, label: () => '肥鱼记忆备份',
          }, BackupPage));
        },
      };
    },
  });
}());

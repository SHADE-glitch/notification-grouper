// prefs.js — notification-grouper 图形设置（GNOME 50 ESM / libadwaita）。
//
// 模型：打开时读 rules.json 进内存模型；编辑只改模型；点"保存"先经
// groupEngine.compileRules 校验（与扩展同一入口），有错误/危险 pattern
// 弹 Adw.AlertDialog 且不写文件；通过才覆写 rules.json，由扩展侧
// FileMonitor 热加载生效。保存时保留文件中未识别的顶层键（如 _note/comment）。

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { compileRules } from './groupEngine.js';

const MODES = ['stack', 'replace'];
const URGENCIES = ['不限', 'low', 'normal', 'critical'];

export default class NotificationGrouperPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(680, 760);
        window.title = 'Notification Grouper 设置';

        this._window = window;
        this._model = this._readModel();

        this._pages = [
            this._buildGeneralPage(),
            this._buildGroupsPage(),
            this._buildRulesPage(),
        ];
        for (const p of this._pages)
            window.add(p);
    }

    // ---------- 模型 ----------

    get _rulesPath() {
        return GLib.build_filenamev([this.path, 'rules.json']);
    }

    _readModel() {
        this._loadError = null;
        const empty = {
            titlePrefixRules: [], sourceRules: [], blockRules: [],
            groups: {}, heuristicTitlePrefix: true, debug: false,
        };
        try {
            const file = Gio.File.new_for_path(this._rulesPath);
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                throw new Error('read failed');
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            this._rawExtra = {}; // 保留未识别顶层键
            for (const [k, v] of Object.entries(parsed)) {
                if (!(k in empty))
                    this._rawExtra[k] = v;
            }
            return {
                titlePrefixRules: Array.isArray(parsed.titlePrefixRules) ? parsed.titlePrefixRules : [],
                sourceRules: Array.isArray(parsed.sourceRules) ? parsed.sourceRules : [],
                blockRules: Array.isArray(parsed.blockRules) ? parsed.blockRules : [],
                groups: parsed.groups && typeof parsed.groups === 'object' && !Array.isArray(parsed.groups)
                    ? parsed.groups : {},
                heuristicTitlePrefix: parsed.heuristicTitlePrefix !== false,
                debug: parsed.debug === true,
            };
        } catch (e) {
            this._rawExtra = {};
            this._loadError = e && e.message ? e.message : String(e);
            return empty;
        }
    }

    _modelToJson() {
        return {
            ...this._rawExtra,
            titlePrefixRules: this._model.titlePrefixRules,
            sourceRules: this._model.sourceRules,
            blockRules: this._model.blockRules,
            groups: this._model.groups,
            heuristicTitlePrefix: this._model.heuristicTitlePrefix,
            debug: this._model.debug,
        };
    }

    _save() {
        const json = this._modelToJsonClean();
        const { errors, rejected } = compileRules(json);
        if (errors.length || rejected.length) {
            const lines = [
                ...errors.map(e => `• ${e.where}: ${e.reason}`),
                ...rejected.map(r => `• ${r.where}: pattern ${JSON.stringify(r.pattern)} 被拒（${r.reason}）`),
            ];
            this._alert('配置未通过校验，未写入文件',
                `共 ${errors.length + rejected.length} 个问题（前 8 条）：\n\n${lines.slice(0, 8).join('\n')}`);
            return;
        }
        try {
            const file = Gio.File.new_for_path(this._rulesPath);
            const text = JSON.stringify(json, null, 2) + '\n';
            file.replace_contents(text, null, false, Gio.FileCreateFlags.NONE, null);
            this._toast('已保存，扩展已热加载新规则');
        } catch (e) {
            this._alert('写入失败', e && e.message ? e.message : String(e));
        }
    }

    // ---------- 通用页 ----------

    _buildGeneralPage() {
        const page = new Adw.PreferencesPage({
            title: '常规',
            icon_name: 'preferences-system-symbolic',
        });

        const sw = new Adw.PreferencesGroup({ title: '开关' });
        page.add(sw);
        sw.add(this._switch('标题前缀启发式', '无规则时对 "Xxx: ..." / "[Xxx] ..." 标题自动成组（恒 stack）',
            this._model.heuristicTitlePrefix, v => { this._model.heuristicTitlePrefix = v; }));
        sw.add(this._switch('调试日志', '每通知记一行日志并附 title（默认关闭：聚合计数行；永不记 body）',
            this._model.debug, v => { this._model.debug = v; }));

        const act = new Adw.PreferencesGroup({ title: '配置' });
        page.add(act);
        const saveRow = new Adw.ButtonRow({
            title: '保存更改到 rules.json',
            subtitle: '保存前自动校验；扩展 FileMonitor 热加载，无需重启 Shell',
        });
        saveRow.connect('activated', () => this._save());
        act.add(saveRow);

        const imp = new Adw.ButtonRow({
            title: '导入 JSON…',
            subtitle: '选择文件，校验通过后替换当前配置',
        });
        imp.connect('activated', () => this._importJson());
        act.add(imp);

        const exp = new Adw.ButtonRow({
            title: '导出当前 rules.json…',
            subtitle: '把磁盘上的当前配置另存为',
        });
        exp.connect('activated', () => this._exportJson());
        act.add(exp);

        const dir = new Adw.ButtonRow({
            title: '打开扩展目录',
            subtitle: this._rulesPath,
        });
        dir.connect('activated', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(`file://${this.path}`, null);
            } catch (e) {
                this._alert('无法打开目录', e && e.message ? e.message : String(e));
            }
        });
        act.add(dir);

        const status = new Adw.PreferencesGroup({ title: '磁盘配置状态' });
        page.add(status);
        this._statusGroup = status;
        this._refreshStatus();

        return page;
    }

    _refreshStatus() {
        const g = this._statusGroup;
        if (!g)
            return;
        if (this._loadError) {
            g.set_description(`rules.json 解析失败：${this._loadError}\n（扩展侧沿用上一份可用规则）`);
            return;
        }
        try {
            const file = Gio.File.new_for_path(this._rulesPath);
            const [, bytes] = file.load_contents(null);
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            const { errors, rejected } = compileRules(parsed);
            g.set_description(errors.length + rejected.length === 0
                ? '校验通过，无被拒绝的规则。'
                : `发现 ${errors.length} 个 schema 错误、${rejected.length} 个被拒 pattern（保存时会逐条提示，扩展侧只记单行日志不刷屏）。`);
        } catch (e) {
            g.set_description(`读取失败：${e && e.message ? e.message : e}`);
        }
    }

    // ---------- groups 页 ----------

    _buildGroupsPage() {
        const page = new Adw.PreferencesPage({
            title: '分组',
            icon_name: 'view-grid-symbolic',
        });
        const holder = new Adw.PreferencesGroup({
            title: 'groups 配置',
            description: 'key 形如 app:code-notify / heur:backup。留空/0 = 用默认（stack、上限 10、无 TTL）。启发式组 mode 恒 stack。',
        });
        page.add(holder);
        this._groupsHolder = holder;

        for (const key of Object.keys(this._model.groups))
            this._addGroupRow(key);

        const add = new Adw.ButtonRow({ title: '添加分组…' });
        add.connect('activated', () => this._promptAddGroup());
        page.add(new Adw.PreferencesGroup());
        page.add(this._wrapRowGroup(add));
        return page;
    }

    _wrapRowGroup(row) {
        const g = new Adw.PreferencesGroup();
        g.add(row);
        return g;
    }

    _promptAddGroup() {
        const dialog = new Adw.AlertDialog({
            heading: '添加分组',
            body: '输入 groupKey（如 app:my-tool）。可用 key 见日志 group= 字段。',
        });
        const entry = new Gtk.Entry({ placeholder_text: 'app:…', activates_default: true });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', '取消');
        dialog.add_response('add', '添加');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('add');
        dialog.connect('response', (_d, resp) => {
            if (resp !== 'add')
                return;
            const key = entry.get_text().trim();
            if (!key) {
                this._alert('未添加', 'groupKey 不能为空。');
                return;
            }
            if (this._model.groups[key]) {
                this._alert('未添加', `分组 ${key} 已存在。`);
                return;
            }
            this._model.groups[key] = {};
            this._addGroupRow(key);
        });
        dialog.present(this._window);
    }

    _addGroupRow(key) {
        const cfg = this._model.groups[key];
        const row = new Adw.ExpanderRow({ title: key, subtitle: '展开编辑' });
        const del = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: '删除该分组',
        });
        del.add_css_class('flat');
        del.connect('clicked', () => {
            delete this._model.groups[key];
            this._groupsHolder.remove(row);
        });
        row.add_suffix(del);
        this._groupsHolder.add(row);

        row.add_row(this._combo('mode', MODES, MODES.indexOf(cfg.mode) >= 0 ? MODES.indexOf(cfg.mode) : 0,
            i => { cfg.mode = MODES[i]; if (i === 0) delete cfg.mode; }));
        row.add_row(this._spin('limit（0=原生10）', cfg.limit ?? 0, 0, 50,
            v => { if (v > 0) cfg.limit = v; else delete cfg.limit; }));
        row.add_row(this._spin('ttlSec（0=关闭）', cfg.ttlSec ?? 0, 0, 86400,
            v => { if (v > 0) cfg.ttlSec = v; else delete cfg.ttlSec; }));
        row.add_row(this._spin('collapseWindowSec（0=关闭）', cfg.collapseWindowSec ?? 0, 0, 3600,
            v => { if (v > 0) cfg.collapseWindowSec = v; else delete cfg.collapseWindowSec; }));
        row.add_row(this._entry('displayName（支持 {count} 占位）', cfg.displayName ?? '',
            t => { if (t) cfg.displayName = t; else delete cfg.displayName; }));
        row.add_row(this._entry('iconName（主题图标名，空=原生回退）', cfg.iconName ?? '',
            t => { if (t) cfg.iconName = t; else delete cfg.iconName; }));
        row.add_row(this._switch('ignoreReplaces', '剥离发送方 replaces_id，每事件强制新卡（默认关）',
            cfg.ignoreReplaces === true, v => { if (v) cfg.ignoreReplaces = true; else delete cfg.ignoreReplaces; }));
        row.add_row(this._switch('showCount', '组头显示组内计数（displayName 无 {count} 时追加 " (N)"）',
            cfg.showCount === true, v => { if (v) cfg.showCount = true; else delete cfg.showCount; }));
    }

    // ---------- 匹配规则页 ----------

    _buildRulesPage() {
        const page = new Adw.PreferencesPage({
            title: '匹配规则',
            icon_name: 'edit-find-symbolic',
        });

        this._titleHolder = new Adw.PreferencesGroup({
            title: '标题前缀规则（titlePrefixRules）',
            description: '匿名来源标题命中 pattern 才合并到 group。pattern 经 ReDoS 审计，危险直接拒载。bodyPattern/urgency 可选叠加过滤。',
        });
        page.add(this._titleHolder);
        this._model.titlePrefixRules.forEach((_r, i) => this._addTitleRuleRow(i));
        page.add(this._wrapRowGroup(this._addBtn('添加标题规则', () => {
            this._model.titlePrefixRules.push({ pattern: '', group: '' });
            this._addTitleRuleRow(this._model.titlePrefixRules.length - 1);
        })));

        this._sourceHolder = new Adw.PreferencesGroup({
            title: '来源规则（sourceRules，白名单强制合并）',
            description: 'appName/desktopEntry/appId 归一化精确匹配，多字段为 AND。命中即并入指定组（匿名来源也可）。',
        });
        page.add(this._sourceHolder);
        this._model.sourceRules.forEach((_r, i) => this._addSourceRuleRow(i));
        page.add(this._wrapRowGroup(this._addBtn('添加来源规则', () => {
            this._model.sourceRules.push({ appName: '', group: '' });
            this._addSourceRuleRow(this._model.sourceRules.length - 1);
        })));

        this._blockHolder = new Adw.PreferencesGroup({
            title: '黑名单（blockRules，永不合并）',
            description: '命中即走原生 per-pid 隔离，优先级最高。至少填一个匹配字段；titlePattern 可与 id 字段叠加（AND）。',
        });
        page.add(this._blockHolder);
        this._model.blockRules.forEach((_r, i) => this._addBlockRuleRow(i));
        page.add(this._wrapRowGroup(this._addBtn('添加黑名单规则', () => {
            this._model.blockRules.push({ appName: '' });
            this._addBlockRuleRow(this._model.blockRules.length - 1);
        })));

        return page;
    }

    _addBtn(title, onClick) {
        const row = new Adw.ButtonRow({ title });
        row.connect('activated', onClick);
        return row;
    }

    _ruleExpander(holder, list, idx, title) {
        const row = new Adw.ExpanderRow({ title });
        const del = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: '删除该规则',
        });
        del.add_css_class('flat');
        del.connect('clicked', () => {
            list[idx] = null;
            holder.remove(row);
        });
        row.add_suffix(del);
        holder.add(row);
        return row;
    }

    _addTitleRuleRow(idx) {
        const list = this._model.titlePrefixRules;
        const r = list[idx];
        const row = this._ruleExpander(this._titleHolder, list, idx, r.pattern || '(新规则)');
        row.add_row(this._entry('pattern（正则，匹配标题）', r.pattern ?? '', t => { r.pattern = t; row.title = t || '(新规则)'; }));
        row.add_row(this._entry('group（目标组名）', r.group ?? '', t => { r.group = t; }));
        row.add_row(this._entry('bodyPattern（可选，匹配正文）', r.bodyPattern ?? '', t => { if (t) r.bodyPattern = t; else delete r.bodyPattern; }));
        const urgIdx = (() => {
            const u = r.urgency;
            if (u == null)
                return 0;
            const s = typeof u === 'number' ? ['low', 'normal', 'critical'][u] : String(u);
            const i = URGENCIES.indexOf(s);
            return i > 0 ? i : 0;
        })();
        row.add_row(this._combo('urgency（可选过滤）', URGENCIES, urgIdx, i => {
            if (i === 0) delete r.urgency; else r.urgency = URGENCIES[i];
        }));
    }

    _addSourceRuleRow(idx) {
        const list = this._model.sourceRules;
        const r = list[idx];
        const row = this._ruleExpander(this._sourceHolder, list, idx, r.appName || r.desktopEntry || r.appId || '(新规则)');
        for (const f of ['appName', 'desktopEntry', 'appId'])
            row.add_row(this._entry(`${f}（精确匹配，可空）`, r[f] ?? '', t => { if (t) r[f] = t; else delete r[f]; }));
        row.add_row(this._entry('group（目标组名）', r.group ?? '', t => { r.group = t; }));
    }

    _addBlockRuleRow(idx) {
        const list = this._model.blockRules;
        const r = list[idx];
        const row = this._ruleExpander(this._blockHolder, list, idx, r.appName || r.desktopEntry || r.appId || r.titlePattern || '(新规则)');
        for (const f of ['appName', 'desktopEntry', 'appId'])
            row.add_row(this._entry(`${f}（精确匹配，可空）`, r[f] ?? '', t => { if (t) r[f] = t; else delete r[f]; }));
        row.add_row(this._entry('titlePattern（正则，可空）', r.titlePattern ?? '', t => { if (t) r.titlePattern = t; else delete r.titlePattern; }));
    }

    // 保存前清洗：剔除被删除(null)与未填完的条目
    _modelToJsonClean() {
        const j = this._modelToJson();
        j.titlePrefixRules = j.titlePrefixRules.filter(r => r && r.pattern && r.group);
        j.sourceRules = j.sourceRules.filter(r => r && (r.appName || r.desktopEntry || r.appId) && r.group);
        j.blockRules = j.blockRules.filter(r => r && (r.appName || r.desktopEntry || r.appId || r.titlePattern));
        return j;
    }

    // ---------- 导入导出 ----------

    _isDismissed(e) {
        try {
            return !!(e && (
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
                e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)));
        } catch {
            return false;
        }
    }

    _importJson() {
        const dlg = new Gtk.FileDialog({ title: '导入配置 JSON' });
        dlg.open(this._window, null, (_d, res) => {
            try {
                const file = dlg.open_finish(res);
                const [, bytes] = file.load_contents(null);
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                const { errors, rejected } = compileRules(parsed);
                if (errors.length || rejected.length) {
                    this._alert('导入文件未通过校验',
                        `${errors.length} 个 schema 错误、${rejected.length} 个被拒 pattern。先在编辑器中修正再导入。`);
                    return;
                }
                // 校验通过：覆写模型并写盘，随后重建页面
                const file2 = Gio.File.new_for_path(this._rulesPath);
                file2.replace_contents(bytes, null, false, Gio.FileCreateFlags.NONE, null);
                this._model = this._readModel();
                this._rebuild();
                this._toast('已导入并热加载');
            } catch (e) {
                if (this._isDismissed(e))
                    return;
                this._alert('导入失败', e && e.message ? e.message : String(e));
            }
        });
    }

    _exportJson() {
        const dlg = new Gtk.FileDialog({
            title: '导出当前 rules.json',
            initial_name: 'notification-grouper-rules.json',
        });
        dlg.save(this._window, null, (_d, res) => {
            try {
                const dest = dlg.save_finish(res);
                const src = Gio.File.new_for_path(this._rulesPath);
                const [, bytes] = src.load_contents(null);
                dest.replace_contents(bytes, null, false, Gio.FileCreateFlags.NONE, null);
                this._toast('已导出');
            } catch (e) {
                if (this._isDismissed(e))
                    return;
                this._alert('导出失败', e && e.message ? e.message : String(e));
            }
        });
    }

    _rebuild() {
        for (const p of this._pages ?? [])
            this._window.remove(p);
        this._pages = [
            this._buildGeneralPage(),
            this._buildGroupsPage(),
            this._buildRulesPage(),
        ];
        for (const p of this._pages)
            this._window.add(p);
    }

    // ---------- 控件工厂 ----------

    _switch(title, subtitle, initial, onChanged) {
        const row = new Adw.SwitchRow({ title, subtitle, active: !!initial });
        row.connect('notify::active', () => onChanged(row.active));
        return row;
    }

    _entry(title, initial, onChanged) {
        const row = new Adw.EntryRow({ title, text: String(initial ?? '') });
        row.connect('changed', () => onChanged(row.text.trim()));
        return row;
    }

    _spin(title, initial, min, max, onChanged) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({
                lower: min, upper: max,
                step_increment: 1, page_increment: 10,
                value: initial,
            }),
            climb_rate: 1,
            digits: 0,
        });
        row.connect('notify::value', () => onChanged(Math.round(row.value)));
        return row;
    }

    _combo(title, items, initial, onSelected) {
        const row = new Adw.ComboRow({
            title,
            model: new Gtk.StringList({ strings: items }),
            selected: Math.max(0, initial),
        });
        row.connect('notify::selected', () => onSelected(row.selected));
        return row;
    }

    _alert(heading, body) {
        const dialog = new Adw.AlertDialog({ heading, body });
        dialog.add_response('ok', '知道了');
        dialog.present(this._window);
    }

    _toast(msg) {
        this._window.add_toast(new Adw.Toast({ title: msg, timeout: 3 }));
    }
}

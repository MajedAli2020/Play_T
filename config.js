'use strict';
// الإعدادات القابلة للتعديل من لوحة التحكم — تنحفظ في data/config.json
const fs = require('fs'), path = require('path');

const FILE = path.join(__dirname, 'data', 'config.json');

const HAND_NAMES = ['ورقة عالية', 'زوج', 'زوجين', 'ثلاثة متشابهة', 'تسلسل', 'فلاش', 'فل هاوس', 'أربعة متشابهة', 'ستريت فلاش'];

/* t: int | float | bool | str | color | list (سطر لكل عنصر) | hands (٩ أسطر) */
const SCHEMA = [
  // الواجهة
  { k: 'title', g: 'الواجهة', t: 'str', max: 30, d: 'رويال بوكر', label: 'اسم اللعبة (عنوان الموقع)' },
  { k: 'accent', g: 'الواجهة', t: 'color', d: '#e7b84b', label: 'اللون الذهبي الرئيسي' },
  { k: 'defaultTicket', g: 'الواجهة', t: 'int', min: 20, max: 1e9, d: 10000, label: 'تذكرة الدخول الافتراضية' },
  { k: 'winMult', g: 'الواجهة', t: 'float', min: 1.1, max: 1000, d: 3, label: 'هدف الفوز الافتراضي (مضاعف التذكرة)' },
  // القواعد
  { k: 'minTicket', g: 'القواعد', t: 'int', min: 1, max: 1e9, d: 20, label: 'أقل تذكرة دخول مسموحة' },
  { k: 'maxTicket', g: 'القواعد', t: 'int', min: 1, max: 1e12, d: 1e9, label: 'أعلى تذكرة دخول مسموحة' },
  { k: 'maxWin', g: 'القواعد', t: 'int', min: 2, max: 1e13, d: 1e12, label: 'أعلى رصيد فوز مسموح' },
  { k: 'minPlayers', g: 'القواعد', t: 'int', min: 2, max: 12, d: 3, label: 'أقل عدد لاعبين لبدء اللعبة' },
  { k: 'maxPlayers', g: 'القواعد', t: 'int', min: 2, max: 12, d: 8, label: 'أقصى عدد لاعبين في الطاولة' },
  { k: 'bbDivisor', g: 'القواعد', t: 'int', min: 2, max: 100000, d: 200, label: 'مقسوم البيج بلايند (البلايند = التذكرة ÷ هذا الرقم × 2)' },
  { k: 'sbRatio', g: 'القواعد', t: 'float', min: 0.05, max: 1, d: 0.5, label: 'السمول بلايند كنسبة من البيج بلايند' },
  { k: 'deckByPlayers', g: 'القواعد', t: 'bool', d: true, label: 'رتب الورق حسب عدد اللاعبين (٤ = أكه شايب بنت ولد، ٥ تزيد العشرة…)' },
  { k: 'minRanks', g: 'القواعد', t: 'int', min: 4, max: 8, d: 4, label: 'أقل عدد رتب في الورق' },
  { k: 'maxRanks', g: 'القواعد', t: 'int', min: 4, max: 8, d: 8, label: 'أكثر عدد رتب في الورق (٨ = لين السبعة)' },
  // التوقيت
  { k: 'turnSec', g: 'التوقيت', t: 'float', min: 2, max: 600, d: 10, label: 'وقت الدور (ثواني)' },
  { k: 'nextSec', g: 'التوقيت', t: 'float', min: 1, max: 120, d: 6.5, label: 'الفاصل بين الأيدي (ثواني)' },
  { k: 'endSec', g: 'التوقيت', t: 'float', min: 1, max: 300, d: 9, label: 'مدة عرض الفائز بعد المباراة (ثواني)' },
  { k: 'graceSec', g: 'التوقيت', t: 'float', min: 0, max: 3600, d: 60, label: 'مهلة رجوع اللاعب بعد ما يطلع (ثواني)' },
  { k: 'idleMin', g: 'التوقيت', t: 'float', min: 1, max: 1440, d: 30, label: 'إغلاق الطاولة بعد عدم النشاط (دقائق)' },
  // الطاولات
  { k: 'maxRooms', g: 'الطاولات', t: 'int', min: 1, max: 5000, d: 200, label: 'أقصى عدد طاولات بنفس الوقت' },
  { k: 'allowWebCreate', g: 'الطاولات', t: 'bool', d: true, label: 'السماح بإنشاء طاولات من الموقع' },
  { k: 'allowJoin', g: 'الطاولات', t: 'bool', d: true, label: 'السماح للاعبين الجدد بالانضمام' },
  { k: 'maintenance', g: 'الطاولات', t: 'bool', d: false, label: 'وضع الصيانة (يمنع إنشاء طاولات جديدة)' },
  { k: 'maintenanceMsg', g: 'الطاولات', t: 'str', max: 120, d: 'اللعبة تحت الصيانة حالياً، جرّب بعد شوي', label: 'رسالة الصيانة' },
  // ديسكورد
  { k: 'baseUrl', g: 'ديسكورد', t: 'str', max: 200, d: '', label: 'الرابط العام للموقع (بدون / في الآخر)' },
  { k: 'logChannelId', g: 'ديسكورد', t: 'str', max: 25, d: '1552271543579574283', label: 'آيدي روم اللوق' },
  { k: 'embedColor', g: 'ديسكورد', t: 'color', d: '#e7b84b', label: 'لون رسائل ديسكورد' },
  { k: 'panelTitle', g: 'ديسكورد', t: 'str', max: 60, d: '♠️ رويال بوكر', label: 'عنوان رسالة الطاولة' },
  { k: 'winTitle', g: 'ديسكورد', t: 'str', max: 60, d: '🏆 نهاية مباراة بوكر', label: 'عنوان لوق الفائز' },
  { k: 'pokerAllowedIds', g: 'ديسكورد', t: 'list', max: 200, d: [], label: 'آيديات مسموح لها تستخدم /poker (فاضي = الكل)' },
  // نصوص
  { k: 'handNames', g: 'النصوص', t: 'hands', d: HAND_NAMES, label: 'أسماء الأوراق (٩ أسطر، من الأضعف للأقوى)' },
  // الحظر
  { k: 'bannedNames', g: 'الحظر', t: 'list', max: 14, d: [], label: 'أسماء ممنوعة (سطر لكل اسم)' },
  { k: 'bannedPids', g: 'الحظر', t: 'list', max: 64, d: [], label: 'معرّفات لاعبين محظورين (تنضاف تلقائياً عند الطرد مع حظر)' }
];

const defaults = () => Object.fromEntries(SCHEMA.map(s => [s.k, Array.isArray(s.d) ? [...s.d] : s.d]));

function clean(spec, v) {
  switch (spec.t) {
    case 'int': {
      const n = Math.floor(+v);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new Error(spec.label + ': لازم بين ' + spec.min + ' و ' + spec.max);
      return n;
    }
    case 'float': {
      const n = +v;
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new Error(spec.label + ': لازم بين ' + spec.min + ' و ' + spec.max);
      return n;
    }
    case 'bool': return v === true || v === 'true' || v === 1;
    case 'color':
      if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) throw new Error(spec.label + ': لون غير صالح');
      return String(v).toLowerCase();
    case 'str': {
      const s = String(v == null ? '' : v).trim();
      if (s.length > spec.max) throw new Error(spec.label + ': أطول من ' + spec.max + ' حرف');
      if (spec.k === 'logChannelId' && s && !/^\d{15,25}$/.test(s)) throw new Error('آيدي الروم لازم أرقام فقط');
      if (spec.k === 'baseUrl' && s && !/^https?:\/\/[^\s/]+[^\s]*$/.test(s)) throw new Error('الرابط لازم يبدأ بـ http:// أو https://');
      return spec.k === 'baseUrl' ? s.replace(/\/+$/, '') : s;
    }
    case 'list': {
      const a = (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
      if (a.length > 500) throw new Error(spec.label + ': كثير');
      return [...new Set(a.map(x => x.slice(0, spec.max)))];
    }
    case 'hands': {
      const a = (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim());
      if (a.length !== 9 || a.some(x => !x || x.length > 30)) throw new Error('أسماء الأوراق: لازم ٩ أسطر، كل سطر من ١ إلى ٣٠ حرف');
      return a;
    }
  }
  throw new Error('نوع غير معروف');
}

/* cfg كائن واحد حيّ: المحرك والبوت والسيرفر كلهم يقرؤون منه مباشرة */
function load(env = {}) {
  const cfg = defaults();
  if (env.baseUrl) cfg.baseUrl = env.baseUrl.replace(/\/+$/, '');
  if (env.logChannelId) cfg.logChannelId = env.logChannelId;
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const s of SCHEMA) if (saved[s.k] !== undefined) { try { cfg[s.k] = clean(s, saved[s.k]); } catch (_) { /* تجاهل القيم التالفة */ } }
  } catch (_) { /* أول تشغيل */ }
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

/* يطبّق تعديلات (كلها أو ولا شي) ويحفظ */
function update(cfg, patch) {
  const next = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const spec = SCHEMA.find(s => s.k === k);
    if (!spec) throw new Error('إعداد غير معروف: ' + k);
    next[k] = clean(spec, v);
  }
  const merged = { ...cfg, ...next };
  if (merged.maxTicket < merged.minTicket) throw new Error('أعلى تذكرة لازم تكون أكبر من أقل تذكرة');
  if (merged.maxRanks < merged.minRanks) throw new Error('أكثر رتب لازم تكون أكبر من أقل رتب');
  if (merged.maxPlayers < merged.minPlayers) throw new Error('أقصى عدد لاعبين لازم يكون أكبر من الأدنى');
  Object.assign(cfg, next);
  save(cfg);
  return next;
}

function reset(cfg) { Object.assign(cfg, defaults()); try { fs.unlinkSync(FILE); } catch (_) { /* */ } }

module.exports = { SCHEMA, HAND_NAMES, defaults, load, save, update, reset };

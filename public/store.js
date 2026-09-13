/*
 * The store. One place, one format, no Markdown.
 *
 * Records live as plain objects in one JSON document under a single localStorage key.
 * Every write goes through save(), so there is exactly one path that can change
 * durable state and exactly one thing to swap out later (a file, SQLite, OPFS)
 * without the surface knowing.
 */
const Store = (() => {
  const KEY = 'proxima.store.v1';
  const EMPTY = { version: 1, projects: [], tasks: [], run: null };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(EMPTY);
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return structuredClone(EMPTY);
      return {
        version: 1,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        run: parsed.run ?? null,
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error && error.name || 'write-failed') };
    }
  }

  const id = (prefix) => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  return {
    snapshot: () => structuredClone(state),

    projects: () => state.projects.slice(),
    addProject(name) {
      const project = { id: id('prj'), name: String(name).trim().slice(0, 120) || 'Untitled project' };
      state.projects.push(project);
      save();
      return project;
    },

    tasks: () => state.tasks.slice(),
    task: (taskId) => state.tasks.find((t) => t.id === taskId) ?? null,

    addTask(fields) {
      const task = {
        id: id('tsk'),
        name: String(fields.name || '').trim().slice(0, 200) || 'Untitled task',
        note: String(fields.note || '').slice(0, 500),
        project: fields.project || '',
        status: ['backlog', 'running', 'finished'].includes(fields.status) ? fields.status : 'backlog',
        weight: clampWeight(fields.weight),
        start: clampDay(fields.start, today()),
        deadline: clampDay(fields.deadline, ''),
        order: state.tasks.length,
        createdAt: new Date().toISOString(),
      };
      state.tasks.push(task);
      save();
      return task;
    },

    updateTask(taskId, fields) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      if ('name' in fields) task.name = String(fields.name).trim().slice(0, 200) || task.name;
      if ('note' in fields) task.note = String(fields.note).slice(0, 500);
      if ('project' in fields) task.project = fields.project || '';
      if ('status' in fields && ['backlog', 'running', 'finished'].includes(fields.status)) task.status = fields.status;
      if ('weight' in fields) task.weight = clampWeight(fields.weight);
      if ('start' in fields) task.start = clampDay(fields.start, task.start || today());
      if ('deadline' in fields) task.deadline = clampDay(fields.deadline, '');
      save();
      return task;
    },

    deleteTask(taskId) {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter((t) => t.id !== taskId);
      save();
      return state.tasks.length < before;
    },

    /** Move a task to a status, inserting it before `beforeId` (or at the end). */
    moveTask(taskId, status, beforeId) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) return false;
      task.status = status;
      const rest = state.tasks.filter((t) => t.id !== taskId);
      const column = rest.filter((t) => t.status === status);
      const index = beforeId ? column.findIndex((t) => t.id === beforeId) : -1;
      if (index < 0) column.push(task); else column.splice(index, 0, task);
      column.forEach((t, i) => { t.order = i; });
      state.tasks = rest.filter((t) => t.status !== status).concat(column);
      save();
      return true;
    },

    run: () => (state.run ? { ...state.run } : null),
    setRun(run) { state.run = run ? { ...run } : null; save(); },
  };

  function clampWeight(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 1;
    return Math.min(100, Math.max(1, n));
  }

  /**
   * A task day, kept as a YYYY-MM-DD string so a deadline or start never drifts by
   * a timezone. `fallback` is what an empty value resolves to, which is how tasks
   * written before the start field existed still get a usable date.
   */
  function clampDay(value, fallback) {
    const text = typeof value === 'string' ? value.trim().slice(0, 10) : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
  }

  function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
})();

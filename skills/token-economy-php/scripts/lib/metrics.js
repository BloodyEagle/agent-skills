// Алгоритмы: defendend/Claude-ast-index-search, src/commands/graph/metrics.rs.
// План: tasks/obs/plan-graph-metrics (3).md + дельта исполнителя (impact).
// Синхронизировать четыре JS-копии; Python-порт проверяется на тех же графах.
// Чистые файловые метрики: A → B означает «A зависит от B».
// Внешние endpoints исключаются, повторные рёбра считаются одной связью.

function percentileRanks(values) {
    const sorted = values.map((value, index) => ({value, index})).sort((a, b) => a.value - b.value);
    const ranks = new Array(values.length);
    for (let start = 0; start < sorted.length;) {
        let end = start + 1;
        while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
        const rank = (start + (end - start) / 2) / sorted.length * 100;
        for (let i = start; i < end; i++) ranks[sorted[i].index] = rank;
        start = end;
    }
    return ranks;
}

function countCycles(outgoing, incoming) {
    const seen = new Set();
    const order = [];
    for (let root = 0; root < outgoing.length; root++) {
        if (seen.has(root)) continue;
        seen.add(root);
        const stack = [[root, 0]];
        while (stack.length) {
            const frame = stack[stack.length - 1];
            const next = outgoing[frame[0]][frame[1]++];
            if (next === undefined) {
                order.push(frame[0]);
                stack.pop();
            } else if (!seen.has(next)) {
                seen.add(next);
                stack.push([next, 0]);
            }
        }
    }
    seen.clear();
    let cycles = 0;
    for (let i = order.length - 1; i >= 0; i--) {
        const root = order[i];
        if (seen.has(root)) continue;
        const stack = [root];
        seen.add(root);
        let size = 0;
        while (stack.length) {
            const node = stack.pop();
            size++;
            for (const next of incoming[node]) {
                if (seen.has(next)) continue;
                seen.add(next);
                stack.push(next);
            }
        }
        if (size > 1 || outgoing[root].includes(root)) cycles++;
    }
    return cycles;
}

/**
 * Вычисляет метрики уникальных файловых связей, исключая внешние endpoints.
 * @param {{files: Array<{id: string|number, path: string}>, edges: Array<{from: string|number, to: string|number, type?: string}>, depth?: number}} input
 * @returns {{perFile: Array<{id: string|number, path: string, fan_in: number, fan_out: number, dependents: number, impact: number, pagerank: number, percentile: {fan_in: number, pagerank: number}, depth: number}>, cycles: number, depth: number}}
 */
function computeMetrics({files, edges, depth = 2}) {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 5) throw new Error('depth должен быть целым числом 1..5');
    const indices = new Map(files.map((file, index) => [file.id, index]));
    if (indices.size !== files.length) throw new Error('Повторный id файла');
    const outgoingSets = files.map(() => new Set());
    const incomingSets = files.map(() => new Set());
    for (const edge of edges) {
        const from = indices.get(edge.from);
        const to = indices.get(edge.to);
        if (from === undefined || to === undefined) continue;
        outgoingSets[from].add(to);
        incomingSets[to].add(from);
    }
    const outgoing = outgoingSets.map(set => [...set]);
    const incoming = incomingSets.map(set => [...set]);
    const count = files.length;
    let pagerank = files.map(() => 1 / count);
    for (let iteration = 0; iteration < 20 && count; iteration++) {
        let dangling = 0;
        for (let i = 0; i < count; i++) if (!outgoing[i].length) dangling += pagerank[i];
        const next = files.map(() => (1 - 0.85) / count + 0.85 * dangling / count);
        for (let from = 0; from < count; from++) {
            if (!outgoing[from].length) continue;
            const share = 0.85 * pagerank[from] / outgoing[from].length;
            for (const to of outgoing[from]) next[to] += share;
        }
        pagerank = next;
    }
    const fanInRanks = percentileRanks(incoming.map(list => list.length));
    const pagerankRanks = percentileRanks(pagerank);
    const perFile = [];
    for (let root = 0; root < count; root++) {
        const seen = new Set([root]);
        const queue = [[root, 0]];
        let dependents = 0;
        // Без shift и ограничения глубины: O(V+E) на цель, корень уже visited.
        for (let head = 0; head < queue.length; head++) {
            const [node, level] = queue[head];
            for (const dependent of incoming[node]) {
                if (seen.has(dependent)) continue;
                seen.add(dependent);
                queue.push([dependent, level + 1]);
                if (level + 1 <= depth) dependents++;
            }
        }
        const file = files[root];
        perFile.push({id: file.id, path: file.path, fan_in: incoming[root].length,
            fan_out: outgoing[root].length, dependents, impact: seen.size - 1, pagerank: pagerank[root],
            percentile: {fan_in: fanInRanks[root], pagerank: pagerankRanks[root]}, depth});
    }
    return {perFile, cycles: countCycles(outgoing, incoming), depth};
}

/**
 * Проверяет выбор file/top и depth без CLI-нормализации.
 * @param {{file?: string|number, top?: string|number, depth?: string|number}} args
 * @returns {{file: string|number|null, top: number, depth: number}}
 */
function parseMetricsArgs(args) {
    const hasFile = args.file !== undefined && args.file !== null && args.file !== '';
    const hasTop = args.top !== undefined && args.top !== null;
    if (hasFile && hasTop) throw new Error('Укажите file либо top, не оба аргумента');
    const integer = value => typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value) : NaN;
    const depth = args.depth === undefined || args.depth === null ? 2 : integer(args.depth);
    const top = hasTop ? integer(args.top) : 15;
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 5) throw new Error('depth должен быть целым числом 1..5');
    if (!Number.isSafeInteger(top) || top < 1) throw new Error('top должен быть положительным целым числом');
    return {file: hasFile ? args.file : null, top, depth};
}

/**
 * Выбирает один id либо стабильный top: fan_in, pagerank, путь.
 * @param {ReturnType<typeof computeMetrics>} metrics
 * @param {{id?: string|number, top?: number}} options
 * @returns {Array<object>}
 */
function metricsRows(metrics, {id, top = 15} = {}) {
    const rows = id === undefined ? [...metrics.perFile] : metrics.perFile.filter(row => row.id === id);
    if (id === undefined) rows.sort((a, b) => b.fan_in - a.fan_in || b.pagerank - a.pagerank ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return rows.slice(0, top).map(row => ({...row, percentile: {...row.percentile}}));
}

/**
 * Форматирует метрики для text-CLI без побочных эффектов.
 * @param {Array<object>} rows
 * @param {{depth?: number, single?: boolean, cycles?: number, cyclesOp?: boolean, cachePath?: string, completeness?: object}} options
 * @returns {string}
 */
function formatMetrics(rows, {depth = 2, single = false, cycles = 0, cyclesOp = false, cachePath = '', completeness} = {}) {
    const lines = rows.map((row, index) => `${single ? '' : (index + 1) + '. '}${row.path}` +
        `  fan-in ${row.fan_in} (p${Math.round(row.percentile.fan_in)})  fan-out ${row.fan_out}` +
        `  dependents(${depth}) ${row.dependents}  impact ${row.impact}` +
        `  pagerank ${row.pagerank.toFixed(4)} (p${Math.round(row.percentile.pagerank)})`);
    if (!rows.length) lines.push('Граф пуст' + (cachePath ? ': ' + cachePath : ''));
    if (cycles) lines.push(`циклов: ${cycles}${cyclesOp ? ' (op=cycles)' : ''}`);
    if (completeness && completeness.complete === false)
        lines.push('Предупреждение: граф неполный (completeness.complete=false)' +
            (completeness.reasons && completeness.reasons.length ? ': ' + completeness.reasons.join(', ') : ''));
    return lines.join('\n');
}

module.exports = {computeMetrics, parseMetricsArgs, metricsRows, formatMetrics};

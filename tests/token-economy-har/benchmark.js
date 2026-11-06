'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function worker(argv) {
    const { parseArgs, run } = require('../../skills/token-economy-har/har');
    const { formatResult } = require('../../skills/token-economy-har/lib/format');
    const { openHar } = require('../../skills/token-economy-har/lib/parse');
    const { createStats, addEntry, finishStats } = require('../../skills/token-economy-har/lib/stats');
    const firstFlag = argv.indexOf('--first');
    const first = firstFlag < 0 ? null : Number(argv.splice(firstFlag, 2)[1]);
    const options = parseArgs(argv);
    const started = performance.now();
    let execution;
    if (first === null) execution = await run(options);
    else {
        const har = await openHar(options.file, { stream: Boolean(options.stream) });
        const aggregate = createStats();
        for await (const { index, entry } of har.entries) {
            if (index < first) addEntry(aggregate, entry);
        }
        execution = { result: finishStats(aggregate, har.metadata, 5), exitCode: aggregate.requests ? 0 : 1 };
    }
    const durationMs = performance.now() - started;
    const output = formatResult(execution.result, options) + '\n';
    const rss = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
    if (options.json) execution.result = JSON.parse(output);
    process.stdout.write(JSON.stringify({ durationMs, rssMiB: rss / 1024 ** 2, outputBytes: Buffer.byteLength(output), outputLines: output.trimEnd().split('\n').length, ...execution }) + '\n');
}

function measure(argv) {
    const started = performance.now();
    const child = spawnSync(process.execPath, [__filename, '--worker', ...argv], {
        encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 120000, windowsHide: true
    });
    if (child.error || child.status !== 0) throw new Error(child.error?.message || child.stderr.trim() || 'Процесс бенчмарка завершился с ошибкой.');
    return { ...JSON.parse(child.stdout), wallMs: performance.now() - started };
}

function generate(directory, megabytes) {
    const files = {
        full: path.join(directory, 'synthetic.har'),
        prefix: path.join(directory, 'first-100.har'),
        small: path.join(directory, 'synthetic-34m.har')
    };
    const payload = 'x'.repeat(256 * 1024);
    const header = '{"log":{"version":"1.2","creator":{"name":"har-benchmark","version":"1"},"pages":[],"entries":[';
    const handles = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.openSync(file, 'wx', 0o600)]));
    const smallLimit = Math.min(megabytes, 34) * 1024 ** 2;
    let bytes = Buffer.byteLength(header) + 3;
    let count = 0;
    let smallCount = 0;
    try {
        for (const fd of Object.values(handles)) fs.writeFileSync(fd, header);
        while (bytes < megabytes * 1024 ** 2) {
            const entry = {
                startedDateTime: new Date(Date.UTC(2026, 0, 1) + count).toISOString(), time: 50,
                request: { method: 'GET', url: `https://benchmark.example.test/resource/${count}`, headers: [] },
                response: { status: 200, bodySize: payload.length, headers: [], content: { size: payload.length, mimeType: 'text/plain', text: payload } },
                timings: { blocked: 1, dns: 1, connect: 10, ssl: 5, send: 1, wait: 30, receive: 7 }
            };
            const encoded = `${count ? ',' : ''}${JSON.stringify(entry)}`;
            fs.writeFileSync(handles.full, encoded);
            if (count < 100) fs.writeFileSync(handles.prefix, encoded);
            if (bytes < smallLimit) {
                fs.writeFileSync(handles.small, encoded);
                smallCount++;
            }
            bytes += Buffer.byteLength(encoded);
            count++;
        }
        for (const fd of Object.values(handles)) fs.writeFileSync(fd, ']}}');
    } finally {
        for (const fd of Object.values(handles)) fs.closeSync(fd);
    }
    return { ...files, count, smallCount, bytes: fs.statSync(files.full).size };
}

function report(label, measurement) {
    process.stdout.write(`${label}: ${measurement.wallMs.toFixed(0)} мс (обработка ${measurement.durationMs.toFixed(0)} мс), RSS ${measurement.rssMiB.toFixed(1)} MiB, вывод ${measurement.outputBytes} B, код ${measurement.exitCode}\n`);
}

function benchmark(argv) {
    const options = { temp: os.tmpdir(), size: 300 };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!['--temp', '--real', '--size'].includes(key) || !argv[i + 1]) throw new Error('Флаги бенчмарка: --temp каталог, --real capture.har, --size 300.');
        options[key.slice(2)] = argv[++i];
    }
    options.size = Number(options.size);
    if (!Number.isFinite(options.size) || options.size < 1) throw new Error('--size: требуется положительный размер в MiB.');
    const directory = fs.mkdtempSync(path.join(options.temp, 'token-economy-har-'));
    try {
        const files = generate(directory, options.size);
        process.stdout.write(`Искусственный HAR: ${(files.bytes / 1024 ** 2).toFixed(1)} MiB, ${files.count} записей.\n`);
        const source = options.real || files.small;
        if (!options.real) process.stdout.write(`Реальный HAR не задан; обычный режим измеряется на искусственном файле ${(fs.statSync(source).size / 1024 ** 2).toFixed(1)} MiB.\n`);
        report('info', measure(['info', '-f', source]));
        report('slow --top 10', measure(['slow', '-f', source, '--top', '10']));
        const automatic = measure(['info', '-f', files.full, '--json']);
        const streaming = measure(['info', '-f', files.full, '--json', '--stream']);
        report('info (автоматический режим)', automatic);
        report('info --stream', streaming);
        process.stdout.write(`Автоматический и явный режимы совпадают: ${JSON.stringify(automatic.result) === JSON.stringify(streaming.result)}\n`);
        const ordinaryPrefix = measure(['info', '-f', files.prefix, '--json']);
        const streamedPrefix = measure(['info', '-f', files.full, '--json', '--stream', '--first', '100']);
        process.stdout.write(`Первые ${Math.min(100, files.count)} записей совпадают с обычным разбором: ${JSON.stringify(ordinaryPrefix.result) === JSON.stringify(streamedPrefix.result)}\n`);
        const capped = measure(['slow', '-f', files.full, '--limit', '1000', '--json', '--pretty']);
        report('slow --limit 1000 --json --pretty', capped);
        process.stdout.write(`Пределы вывода: ${capped.outputBytes <= 8192 && capped.outputLines <= 200}; строки=${capped.outputLines}; счётчики обрезки: ${capped.result.shown === capped.result.items.length && capped.result.omitted === capped.result.total - capped.result.shown}\n`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

if (process.argv[2] === '--worker') {
    worker(process.argv.slice(3)).catch(error => {
        process.stderr.write(`Ошибка бенчмарка: ${error.message}\n`);
        process.exitCode = 2;
    });
} else {
    try {
        benchmark(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`Ошибка бенчмарка: ${error.message}\n`);
        process.exitCode = 2;
    }
}

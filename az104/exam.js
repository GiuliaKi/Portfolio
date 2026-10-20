(function () {
    "use strict";

    const FULL_MODE = { type: "full", size: 60, minutes: 120 };
    const DOMAIN_FORMATS = {
        short: { size: 30, minutes: 50 },
        long: { size: 60, minutes: 100 },
    };
    const PASS_SCORE = 700;
    const CASE_STUDY_MIN_SIZE = 8;
    const HISTORY_KEY = "az104.history.v1";
    const DOMAIN_HISTORY_KEY = "az104.history.domain.v1";
    const CURRENT_KEY = "az104.current.v1";

    const DOMAINS = {
        identity: "Identità e governance",
        storage: "Storage",
        compute: "Compute",
        network: "Networking",
        monitor: "Monitor e backup",
    };
    const DOMAIN_ORDER = Object.keys(DOMAINS);

    const bank = window.AZ104_BANK;
    const byId = new Map(bank.questions.map((q) => [q.id, q]));

    let exam = null;
    let timerHandle = null;
    let lastResult = null;
    let detailEntryId = null;
    let detailEntryKey = HISTORY_KEY;
    const charts = {};

    const $ = (id) => document.getElementById(id);

    // ---------- utilità ----------

    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }

    function linkify(s) {
        return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    }

    const CODE_LINE = /^([\[\]{}]|"[^"]*"\s*:)/;

    function renderBlocks(blocks) {
        let html = "";
        let code = [];
        const flush = () => {
            if (code.length) {
                html += `<pre>${esc(code.join("\n"))}</pre>`;
                code = [];
            }
        };
        for (const b of blocks) {
            if (b.img) {
                flush();
                html += `<img class="exhibit" src="${esc(b.img)}" alt="Exhibit" loading="lazy">`;
            } else if (CODE_LINE.test(b.p)) {
                code.push(b.p);
            } else {
                flush();
                html += `<p>${linkify(b.p)}</p>`;
            }
        }
        flush();
        return html;
    }

    function fmtClock(ms) {
        const total = Math.max(0, Math.round(ms / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    function fmtDuration(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m} min ${String(s).padStart(2, "0")} s`;
    }

    function fmtDate(iso) {
        return new Date(iso).toLocaleString("it-IT", {
            day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
        });
    }

    function show(viewId) {
        for (const id of ["view-home", "view-exam", "view-results", "view-history-detail"]) {
            $(id).hidden = id !== viewId;
        }
        window.scrollTo(0, 0);
    }

    function loadJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            /* storage pieno o disabilitato: il test continua senza salvataggio */
        }
    }

    // Test e risultati salvati prima dell'introduzione delle modalità non hanno "mode".
    function modeOf(obj) {
        return (obj && obj.mode) || FULL_MODE;
    }

    function historyKeyFor(mode) {
        return mode.type === "domain" ? DOMAIN_HISTORY_KEY : HISTORY_KEY;
    }

    function modeLabel(mode) {
        return mode.type === "domain"
            ? `Test per argomento: ${DOMAINS[mode.domain]} (${mode.size} domande, ${mode.minutes} min)`
            : "Esame completo";
    }

    function domainPoolSize(domain) {
        return bank.questions.filter((q) => q.domain === domain).length;
    }

    // ---------- costruzione del test ----------

    function buildQuestionList(mode) {
        const pool = mode.type === "domain"
            ? bank.questions.filter((q) => q.domain === mode.domain)
            : bank.questions;
        const units = [];
        const unitIndex = new Map();
        for (const q of pool) {
            if (!unitIndex.has(q.group)) {
                unitIndex.set(q.group, units.length);
                units.push([]);
            }
            units[unitIndex.get(q.group)].push(q.id);
        }
        shuffle(units);

        const isCaseStudy = (unit) => {
            const first = byId.get(unit[0]).stem.map((b) => b.p || "").join(" ");
            return unit.length >= CASE_STUDY_MIN_SIZE || /case study/i.test(first);
        };

        // Nei test per argomento il limite di un case study ridurrebbe troppo le domande disponibili.
        const limitCaseStudies = mode.type === "full";
        const picked = [];
        let count = 0;
        let hasCaseStudy = false;
        for (const unit of units) {
            if (count === mode.size) break;
            if (count + unit.length > mode.size) continue;
            if (limitCaseStudies && isCaseStudy(unit)) {
                if (hasCaseStudy) continue;
                hasCaseStudy = true;
            }
            picked.push(unit);
            count += unit.length;
        }
        return picked.flat();
    }

    function startExam(mode) {
        const now = Date.now();
        exam = {
            mode,
            ids: buildQuestionList(mode),
            answers: {},
            flagged: {},
            current: 0,
            startedAt: new Date(now).toISOString(),
            endsAt: now + mode.minutes * 60 * 1000,
        };
        persistExam();
        openExam();
    }

    function persistExam() {
        if (exam) saveJson(CURRENT_KEY, exam);
    }

    function openExam() {
        show("view-exam");
        renderQuestion();
        tick();
        clearInterval(timerHandle);
        timerHandle = setInterval(tick, 1000);
    }

    function tick() {
        const left = exam.endsAt - Date.now();
        const el = $("exam-timer");
        el.textContent = fmtClock(left);
        el.classList.toggle("low", left < 10 * 60 * 1000);
        if (left <= 0) finishExam(true);
    }

    // ---------- rendering domanda ----------

    function groupInfo(index) {
        const q = byId.get(exam.ids[index]);
        const members = exam.ids.filter((id) => byId.get(id).group === q.group);
        if (members.length < 2) return null;
        return { pos: members.indexOf(q.id) + 1, size: members.length };
    }

    function renderQuestion() {
        const i = exam.current;
        const q = byId.get(exam.ids[i]);
        const chosen = exam.answers[q.id] || [];

        const mode = modeOf(exam);
        $("exam-progress").textContent = `Domanda ${i + 1} di ${exam.ids.length}` +
            (mode.type === "domain" ? ` \u00b7 ${DOMAINS[mode.domain]}` : "");

        const g = groupInfo(i);
        $("exam-group").hidden = !g;
        if (g) $("exam-group").textContent = `Scenario condiviso: domanda ${g.pos} di ${g.size}`;

        $("exam-stem").innerHTML = renderBlocks(q.stem);

        const hint = $("exam-hint");
        hint.hidden = !q.multi;
        if (q.multi) hint.textContent = `Seleziona ${q.correct.length} risposte.`;

        const type = q.multi ? "checkbox" : "radio";
        $("exam-options").innerHTML = q.options.map((opt, k) => `
            <label class="exam-option${chosen.includes(k) ? " selected" : ""}">
                <input type="${type}" name="opt" value="${k}"${chosen.includes(k) ? " checked" : ""}>
                <span>${linkify(opt)}</span>
            </label>`).join("");

        for (const input of $("exam-options").querySelectorAll("input")) {
            input.addEventListener("change", () => onAnswer(q, input));
        }

        $("btn-prev").disabled = i === 0;
        $("btn-next").textContent = i === exam.ids.length - 1 ? "Consegna" : "Successiva \u2192";
        $("btn-flag").textContent = exam.flagged[q.id] ? "Rimuovi segnalazione" : "Segna per revisione";
        renderNav();
    }

    function onAnswer(q, input) {
        const k = Number(input.value);
        let chosen = exam.answers[q.id] ? exam.answers[q.id].slice() : [];
        if (q.multi) {
            if (input.checked) {
                if (chosen.length >= q.correct.length) {
                    input.checked = false;
                    return;
                }
                chosen.push(k);
            } else {
                chosen = chosen.filter((x) => x !== k);
            }
        } else {
            chosen = [k];
        }
        if (chosen.length) exam.answers[q.id] = chosen;
        else delete exam.answers[q.id];
        persistExam();

        for (const label of $("exam-options").querySelectorAll(".exam-option")) {
            label.classList.toggle("selected", label.querySelector("input").checked);
        }
        renderNav();
    }

    function renderNav() {
        $("exam-nav").innerHTML = exam.ids.map((id, k) => {
            const cls = [
                exam.answers[id] ? "answered" : "",
                exam.flagged[id] ? "flagged" : "",
                k === exam.current ? "current" : "",
            ].join(" ");
            return `<button type="button" class="${cls}" data-k="${k}">${k + 1}</button>`;
        }).join("");
    }

    function goTo(k) {
        exam.current = Math.max(0, Math.min(exam.ids.length - 1, k));
        persistExam();
        renderQuestion();
        window.scrollTo(0, 0);
    }

    function confirmFinish() {
        const unanswered = exam.ids.filter((id) => !exam.answers[id]).length;
        const msg = unanswered
            ? `Ci sono ${unanswered} domande senza risposta. Vuoi consegnare il test?`
            : "Vuoi consegnare il test?";
        if (window.confirm(msg)) finishExam(false);
    }

    // ---------- correzione ----------

    function grade(state) {
        const items = state.ids.map((id) => {
            const q = byId.get(id);
            const given = (state.answers[id] || []).slice().sort((a, b) => a - b);
            const right = q.correct.slice().sort((a, b) => a - b);
            const answered = given.length > 0;
            const ok = answered && given.length === right.length && given.every((v, i) => v === right[i]);
            return { q, given, ok, answered };
        });
        const byDomain = {};
        for (const d of DOMAIN_ORDER) byDomain[d] = { correct: 0, total: 0 };
        for (const it of items) {
            const d = byDomain[it.q.domain] ? it.q.domain : "monitor";
            byDomain[d].total++;
            if (it.ok) byDomain[d].correct++;
        }
        const correct = items.filter((it) => it.ok).length;
        const unanswered = items.filter((it) => !it.answered).length;
        const total = items.length;
        const score = Math.round((correct / total) * 1000);
        return {
            items, byDomain, correct, unanswered, total,
            wrong: total - correct - unanswered,
            score, passed: score >= PASS_SCORE,
        };
    }

    function finishExam(timeUp) {
        if (!exam) return;
        clearInterval(timerHandle);
        const finishedAt = Math.min(Date.now(), exam.endsAt);
        const g = grade(exam);
        const mode = modeOf(exam);
        const entry = {
            id: exam.startedAt,
            mode,
            startedAt: exam.startedAt,
            finishedAt: new Date(finishedAt).toISOString(),
            durationSec: Math.round((finishedAt - Date.parse(exam.startedAt)) / 1000),
            total: g.total,
            correct: g.correct,
            wrong: g.wrong,
            unanswered: g.unanswered,
            score: g.score,
            passed: g.passed,
            timeUp,
            byDomain: g.byDomain,
        };
        const key = historyKeyFor(mode);
        const history = loadJson(key, []).filter((h) => h.id !== entry.id);
        history.push(entry);
        saveJson(key, history);
        localStorage.removeItem(CURRENT_KEY);

        lastResult = { ...g, entry };
        exam = null;
        renderResults();
    }

    // ---------- risultati ----------

    function summaryHtml(entry) {
        const cls = entry.passed ? "pass" : "fail";
        return `
            <div class="az-card">
                <div class="score-grid">
                    <div class="score-box"><div class="value ${cls}">${entry.score}</div><div class="label">Punteggio / 1000</div></div>
                    <div class="score-box"><div class="value ${cls}">${entry.passed ? "Superato" : "Non superato"}</div><div class="label">Soglia ${PASS_SCORE}</div></div>
                    <div class="score-box"><div class="value pass">${entry.correct}</div><div class="label">Corrette</div></div>
                    <div class="score-box"><div class="value fail">${entry.wrong}</div><div class="label">Sbagliate</div></div>
                    <div class="score-box"><div class="value">${entry.unanswered}</div><div class="label">Senza risposta</div></div>
                    <div class="score-box"><div class="value">${fmtDuration(entry.durationSec)}</div><div class="label">Tempo impiegato</div></div>
                </div>
                <p class="text-muted small mt-3 mb-0">${esc(modeLabel(modeOf(entry)))} &middot; iniziato il ${fmtDate(entry.startedAt)} &middot; ${entry.correct}/${entry.total} corrette (${Math.round((entry.correct / entry.total) * 100)}%)</p>
            </div>`;
    }

    function domainTableHtml(byDomain) {
        const rows = DOMAIN_ORDER.filter((d) => byDomain[d] && byDomain[d].total).map((d) => {
            const { correct, total } = byDomain[d];
            const pct = Math.round((correct / total) * 100);
            return `<tr><td>${DOMAINS[d]}</td><td>${correct}/${total}</td><td class="${pct >= 70 ? "pass" : "fail"}">${pct}%</td></tr>`;
        }).join("");
        return `<table class="table table-sm domain-table mt-3 mb-0"><thead><tr><th>Area</th><th>Corrette</th><th>%</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function drawDomainChart(canvasId, byDomain) {
        if (!window.Chart) return;
        if (charts[canvasId]) charts[canvasId].destroy();
        const ds = DOMAIN_ORDER.filter((d) => byDomain[d] && byDomain[d].total);
        const pcts = ds.map((d) => Math.round((byDomain[d].correct / byDomain[d].total) * 100));
        charts[canvasId] = new Chart($(canvasId), {
            type: "bar",
            data: {
                labels: ds.map((d) => `${DOMAINS[d]} (${byDomain[d].total})`),
                datasets: [{
                    label: "% risposte corrette",
                    data: pcts,
                    backgroundColor: pcts.map((p) => (p >= 70 ? "#2e9e8f" : "#e07a5f")),
                }],
            },
            options: {
                indexAxis: "y",
                maintainAspectRatio: false,
                scales: { x: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } } },
                plugins: { legend: { display: false } },
            },
        });
    }

    function reviewHtml(items, onlyWrong) {
        return items.map((it, n) => {
            if (onlyWrong && it.ok) return "";
            const q = it.q;
            const status = it.ok ? "Corretta" : it.answered ? "Sbagliata" : "Senza risposta";
            const cls = it.ok ? "ok" : it.answered ? "" : "skipped";
            const opts = q.options.map((o, k) => {
                const isRight = q.correct.includes(k);
                const isChosen = it.given.includes(k);
                const tags = [isChosen ? "tua risposta" : "", isRight ? "risposta corretta" : ""].filter(Boolean).join(", ");
                const c = isRight ? "is-correct" : isChosen ? "is-wrong-choice" : "";
                return `<li class="${c}">${linkify(o)}${tags ? ` <small>(${tags})</small>` : ""}</li>`;
            }).join("");
            const refs = q.refs.length
                ? `<div class="review-refs mt-2"><b>Riferimenti:</b><br>${q.refs.map((r) => `<a href="${esc(r)}" target="_blank" rel="noopener">${esc(r)}</a>`).join("<br>")}</div>`
                : "";
            return `
                <div class="az-card review-item ${cls}">
                    <div class="review-head">
                        <b>Domanda ${n + 1} &middot; ${DOMAINS[q.domain] || ""}</b>
                        <span class="${it.ok ? "pass" : "fail"} font-weight-bold">${status}</span>
                    </div>
                    <div class="review-stem">${renderBlocks(q.stem)}</div>
                    <ul class="review-options">${opts}</ul>
                    <div class="review-expl"><b>Spiegazione</b>${renderBlocks(q.explanation)}${refs}</div>
                </div>`;
        }).join("");
    }

    function domainEntries(domain) {
        return loadJson(DOMAIN_HISTORY_KEY, [])
            .filter((h) => modeOf(h).domain === domain)
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }

    // Andamento del punteggio nel tempo; il test evidenziato (se presente) ha un punto più grande.
    function drawTrend(canvasId, entriesAsc, highlightId) {
        if (!window.Chart) return;
        if (charts[canvasId]) charts[canvasId].destroy();
        const label = (h) => {
            const m = modeOf(h);
            return m.type === "domain" ? `${fmtDate(h.startedAt)} (${m.size})` : fmtDate(h.startedAt);
        };
        charts[canvasId] = new Chart($(canvasId), {
            type: "line",
            data: {
                labels: entriesAsc.map(label),
                datasets: [
                    {
                        label: "Punteggio",
                        data: entriesAsc.map((h) => h.score),
                        borderColor: "#008080",
                        backgroundColor: "#008080",
                        pointRadius: entriesAsc.map((h) => (h.id === highlightId ? 7 : 3)),
                        tension: 0.2,
                    },
                    { label: "Soglia 700", data: entriesAsc.map(() => PASS_SCORE), borderColor: "#e07a5f", borderDash: [6, 4], pointRadius: 0 },
                ],
            },
            options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 1000 } } },
        });
    }

    // Esame completo: grafico per area. Test per argomento: andamento dei test dello stesso argomento.
    function drawEntryChart(canvasId, titleId, entry, byDomain) {
        const mode = modeOf(entry);
        if (mode.type === "domain") {
            $(titleId).textContent = `Andamento dei test: ${DOMAINS[mode.domain]}`;
            drawTrend(canvasId, domainEntries(mode.domain), entry.id);
        } else {
            $(titleId).textContent = "Risultati per area d'esame";
            drawDomainChart(canvasId, byDomain);
        }
    }

    function renderResults() {
        const r = lastResult;
        show("view-results");
        $("results-timeup").hidden = !r.entry.timeUp;
        $("results-summary").innerHTML = summaryHtml(r.entry);
        $("results-domains").innerHTML = domainTableHtml(r.byDomain);
        $("only-wrong").checked = false;
        $("results-review").innerHTML = reviewHtml(r.items, false);
        drawEntryChart("results-chart", "results-chart-title", r.entry, r.byDomain);
    }

    // ---------- home e storico ----------

    function historyRow(h, withDomain) {
        const m = modeOf(h);
        const domainCells = withDomain ? `<td>${DOMAINS[m.domain] || ""}</td><td>${m.size} dom. / ${m.minutes} min</td>` : "";
        return `
            <tr data-id="${esc(h.id)}" data-kind="${m.type}">
                <td>${fmtDate(h.startedAt)}</td>
                ${domainCells}
                <td class="${h.passed ? "pass" : "fail"} font-weight-bold">${h.score}</td>
                <td>${h.correct}</td>
                <td>${h.wrong + h.unanswered}</td>
                <td>${fmtDuration(h.durationSec)}</td>
                <td>${h.passed ? "Superato" : "Non superato"}${h.timeUp ? " (tempo scaduto)" : ""}</td>
            </tr>`;
    }

    function updateFormatAvailability() {
        const pool = domainPoolSize($("domain-select").value);
        const long = $("format-long");
        long.disabled = pool < DOMAIN_FORMATS.long.size;
        if (long.disabled && long.checked) $("format-short").checked = true;
        $("format-note").hidden = !long.disabled;
        $("format-note").textContent = `Per questo argomento ci sono solo ${pool} domande: disponibile il formato da 30.`;
    }

    function renderHome() {
        show("view-home");
        $("bank-info").textContent =
            `Banca domande: ${bank.questions.length} domande da ${bank.sources.length} practice test.`;

        const saved = loadJson(CURRENT_KEY, null);
        $("resume-box").hidden = !saved;
        if (saved) {
            const answered = Object.keys(saved.answers).length;
            const left = saved.endsAt - Date.now();
            $("resume-info").textContent = `${modeLabel(modeOf(saved))}: ` + (left > 0
                ? `${answered}/${saved.ids.length} risposte date, tempo rimanente ${fmtClock(left)}.`
                : "il tempo è scaduto, riprendendo il test verrà consegnato.");
        }

        updateFormatAvailability();

        const history = loadJson(HISTORY_KEY, []).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        $("history-empty").hidden = history.length > 0;
        $("history-table").hidden = history.length === 0;
        $("history-table").querySelector("tbody").innerHTML = history.map((h) => historyRow(h, false)).join("");
        $("history-trend-wrap").hidden = history.length < 2;
        if (history.length >= 2) drawTrend("history-trend", history.slice().reverse(), null);

        renderDomainHistory();
    }

    function renderDomainHistory() {
        const filter = $("domain-history-filter").value;
        const all = loadJson(DOMAIN_HISTORY_KEY, []);
        const rows = all
            .filter((h) => filter === "all" || modeOf(h).domain === filter)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        $("domain-history-empty").hidden = rows.length > 0;
        $("domain-history-empty").textContent = all.length
            ? "Nessun test svolto per questo argomento."
            : "Nessun test per argomento svolto su questo browser.";
        $("domain-history-table").hidden = rows.length === 0;
        $("domain-history-table").querySelector("tbody").innerHTML = rows.map((h) => historyRow(h, true)).join("");

        $("domain-trend-hint").hidden = !(filter === "all" && all.length > 0);
        const showTrend = filter !== "all" && rows.length >= 2;
        $("domain-trend-wrap").hidden = !showTrend;
        if (showTrend) drawTrend("domain-trend", rows.slice().reverse(), null);
    }

    function openHistoryDetail(id, kind) {
        const key = kind === "domain" ? DOMAIN_HISTORY_KEY : HISTORY_KEY;
        const entry = loadJson(key, []).find((h) => h.id === id);
        if (!entry) return;
        detailEntryId = id;
        detailEntryKey = key;
        show("view-history-detail");
        const mode = modeOf(entry);
        $("detail-title").textContent = mode.type === "domain"
            ? `${DOMAINS[mode.domain]} \u00b7 test del ${fmtDate(entry.startedAt)}`
            : `Esame completo del ${fmtDate(entry.startedAt)}`;
        $("detail-summary").innerHTML = summaryHtml(entry);
        $("detail-domains").innerHTML = domainTableHtml(entry.byDomain);
        drawEntryChart("detail-chart", "detail-chart-title", entry, entry.byDomain);
    }

    // ---------- PDF ----------

    function pdfSafe(s) {
        return String(s)
            .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
            .replace(/[\u2018\u2019\u201A]/g, "'")
            .replace(/[\u2013\u2014\u2212]/g, "-")
            .replace(/\u2026/g, "...")
            .replace(/\u2192/g, "->")
            .replace(/\u2190/g, "<-")
            .replace(/[\u2022\u25CF]/g, "-")
            .replace(/\u00A0/g, " ")
            .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A1-\u00FF]/g, "?");
    }

    function imageToJpeg(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const scale = Math.min(1, 1000 / img.naturalWidth);
                    const c = document.createElement("canvas");
                    c.width = Math.round(img.naturalWidth * scale);
                    c.height = Math.round(img.naturalHeight * scale);
                    const ctx = c.getContext("2d");
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, c.width, c.height);
                    ctx.drawImage(img, 0, 0, c.width, c.height);
                    resolve({ data: c.toDataURL("image/jpeg", 0.85), w: c.width, h: c.height });
                } catch (e) {
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    async function downloadPdf() {
        if (!window.jspdf || !lastResult) {
            window.alert("Generazione PDF non disponibile (libreria non caricata).");
            return;
        }
        const btn = $("btn-pdf");
        btn.disabled = true;
        btn.textContent = "Generazione PDF...";
        try {
            await buildPdf(lastResult);
        } finally {
            btn.disabled = false;
            btn.textContent = "Scarica PDF del riepilogo";
        }
    }

    async function buildPdf(r) {
        const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
        const M = 15;
        const W = 210 - 2 * M;
        const PAGE_H = 297;
        let y = M;

        const ensure = (h) => {
            if (y + h > PAGE_H - M) {
                doc.addPage();
                y = M;
            }
        };
        const write = (s, opts = {}) => {
            const size = opts.size || 10;
            const indent = opts.indent || 0;
            doc.setFont("helvetica", opts.style || "normal");
            doc.setFontSize(size);
            doc.setTextColor(...(opts.color || [0, 0, 0]));
            const lh = size * 0.3528 * 1.3;
            for (const line of doc.splitTextToSize(pdfSafe(s), W - indent)) {
                ensure(lh);
                doc.text(line, M + indent, y + lh * 0.8);
                y += lh;
            }
        };
        const gap = (h) => { y += h; };
        const blocks = async (list, indent = 0) => {
            for (const b of list) {
                if (b.img) {
                    const im = await imageToJpeg(b.img);
                    if (!im) {
                        write("[immagine non disponibile nel PDF]", { size: 9, color: [120, 120, 120], indent });
                        continue;
                    }
                    let w = W - indent;
                    let h = (im.h / im.w) * w;
                    if (h > 110) {
                        h = 110;
                        w = (im.w / im.h) * h;
                    }
                    ensure(h + 2);
                    doc.addImage(im.data, "JPEG", M + indent, y, w, h);
                    y += h + 2;
                } else {
                    write(b.p, { size: 9.5, indent });
                }
            }
        };

        const e = r.entry;
        write("AZ-104 - Simulazione d'esame", { size: 18, style: "bold", color: [0, 102, 102] });
        write(modeLabel(modeOf(e)), { size: 11, style: "bold" });
        write(`Test del ${fmtDate(e.startedAt)} - durata ${fmtDuration(e.durationSec)}${e.timeUp ? " (tempo scaduto)" : ""}`, { size: 10, color: [90, 90, 90] });
        gap(3);
        write(`Punteggio: ${e.score}/1000 - ${e.passed ? "SUPERATO" : "NON SUPERATO"} (soglia ${PASS_SCORE})`, {
            size: 13, style: "bold", color: e.passed ? [30, 132, 73] : [192, 57, 43],
        });
        write(`Corrette: ${e.correct}   Sbagliate: ${e.wrong}   Senza risposta: ${e.unanswered}   Totale: ${e.total}`, { size: 11 });
        gap(3);
        write("Risultati per area d'esame", { size: 12, style: "bold" });
        for (const d of DOMAIN_ORDER) {
            const s = r.byDomain[d];
            if (!s || !s.total) continue;
            write(`- ${DOMAINS[d]}: ${s.correct}/${s.total} (${Math.round((s.correct / s.total) * 100)}%)`, { size: 10.5, indent: 2 });
        }

        for (let n = 0; n < r.items.length; n++) {
            const it = r.items[n];
            const q = it.q;
            gap(5);
            ensure(20);
            doc.setDrawColor(200, 214, 214);
            doc.line(M, y, M + W, y);
            gap(2);
            const status = it.ok ? "CORRETTA" : it.answered ? "SBAGLIATA" : "SENZA RISPOSTA";
            write(`Domanda ${n + 1} - ${DOMAINS[q.domain] || ""} - ${status}`, {
                size: 11, style: "bold", color: it.ok ? [30, 132, 73] : [192, 57, 43],
            });
            gap(1);
            await blocks(q.stem);
            gap(1);
            q.options.forEach((o, k) => {
                const isRight = q.correct.includes(k);
                const isChosen = it.given.includes(k);
                const tags = [isChosen ? "tua risposta" : "", isRight ? "corretta" : ""].filter(Boolean).join(", ");
                write(`${isRight ? "[OK]" : isChosen ? "[X]" : "[  ]"} ${o}${tags ? `  (${tags})` : ""}`, {
                    size: 9.5,
                    indent: 3,
                    style: isRight ? "bold" : "normal",
                    color: isRight ? [30, 132, 73] : isChosen ? [192, 57, 43] : [0, 0, 0],
                });
            });
            gap(1.5);
            write("Spiegazione", { size: 10, style: "bold", color: [0, 102, 102] });
            await blocks(q.explanation, 2);
            if (q.refs.length) {
                write("Riferimenti:", { size: 9, style: "bold", indent: 2 });
                for (const ref of q.refs) write(ref, { size: 8.5, indent: 2, color: [0, 102, 153] });
            }
        }

        const d = new Date(e.startedAt);
        const pad = (v) => String(v).padStart(2, "0");
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
        doc.save(`AZ-104_simulazione_${stamp}.pdf`);
    }

    // ---------- eventi ----------

    function fillSelects() {
        $("domain-select").innerHTML = DOMAIN_ORDER
            .map((d) => `<option value="${d}">${DOMAINS[d]} (${domainPoolSize(d)} domande)</option>`)
            .join("");
        $("domain-history-filter").innerHTML = `<option value="all">Tutti gli argomenti</option>` +
            DOMAIN_ORDER.map((d) => `<option value="${d}">${DOMAINS[d]}</option>`).join("");
    }

    function confirmAndStart(mode) {
        if (loadJson(CURRENT_KEY, null) && !window.confirm("C'è un test in corso: verrà abbandonato. Iniziare un nuovo test?")) return;
        localStorage.removeItem(CURRENT_KEY);
        startExam(mode);
    }

    function bind() {
        $("btn-start").addEventListener("click", () => confirmAndStart(FULL_MODE));
        $("btn-start-domain").addEventListener("click", () => {
            const domain = $("domain-select").value;
            const format = document.querySelector("input[name='domain-format']:checked").value;
            confirmAndStart({ type: "domain", domain, ...DOMAIN_FORMATS[format] });
        });
        $("domain-select").addEventListener("change", updateFormatAvailability);
        $("domain-history-filter").addEventListener("change", renderDomainHistory);
        $("btn-resume").addEventListener("click", () => {
            exam = loadJson(CURRENT_KEY, null);
            if (!exam) return renderHome();
            if (exam.endsAt <= Date.now()) finishExam(true);
            else openExam();
        });
        $("btn-discard").addEventListener("click", () => {
            if (!window.confirm("Abbandonare il test in corso? Non verrà salvato nello storico.")) return;
            localStorage.removeItem(CURRENT_KEY);
            renderHome();
        });

        $("btn-prev").addEventListener("click", () => goTo(exam.current - 1));
        $("btn-next").addEventListener("click", () => {
            if (exam.current === exam.ids.length - 1) confirmFinish();
            else goTo(exam.current + 1);
        });
        $("btn-flag").addEventListener("click", () => {
            const id = exam.ids[exam.current];
            if (exam.flagged[id]) delete exam.flagged[id];
            else exam.flagged[id] = true;
            persistExam();
            renderQuestion();
        });
        $("btn-finish").addEventListener("click", confirmFinish);
        $("exam-nav").addEventListener("click", (ev) => {
            const b = ev.target.closest("button[data-k]");
            if (b) goTo(Number(b.dataset.k));
        });

        $("btn-pdf").addEventListener("click", downloadPdf);
        $("btn-new").addEventListener("click", renderHome);
        $("only-wrong").addEventListener("change", (ev) => {
            $("results-review").innerHTML = reviewHtml(lastResult.items, ev.target.checked);
        });

        for (const tableId of ["history-table", "domain-history-table"]) {
            $(tableId).addEventListener("click", (ev) => {
                const tr = ev.target.closest("tr[data-id]");
                if (tr) openHistoryDetail(tr.dataset.id, tr.dataset.kind);
            });
        }
        $("btn-back-home").addEventListener("click", renderHome);
        $("btn-delete-entry").addEventListener("click", () => {
            if (!window.confirm("Eliminare questo risultato dallo storico?")) return;
            saveJson(detailEntryKey, loadJson(detailEntryKey, []).filter((h) => h.id !== detailEntryId));
            renderHome();
        });
    }

    fillSelects();
    bind();
    renderHome();
})();

// -----------------------------------------------------------
// [SME 개발 사수] 웹 버전 DB 조회 프로그램 (PK 정렬 우선 Ver)
// -----------------------------------------------------------

// 1. 필수 라이브러리 로딩 및 설정 검사
try {
    require('dotenv').config();

    // [설정 검사] .env 파일 체크
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl || !dbUrl.startsWith('mysql://')) {
        console.clear();
        console.error("\n❌ [설정 오류] .env 파일의 DB 주소가 잘못되었습니다!");
        console.error("   해결: mysql:// 로 시작하는지 확인해주세요.");
        process.exit(1);
    }

    var express = require('express');
    var { PrismaClient } = require('@prisma/client');
    var iconv = require('iconv-lite');
    var fs = require('fs');
    var path = require('path');
} catch (e) {
    console.error("\n❌ [비상] 필수 도구가 설치되지 않았습니다!");
    console.error("   터미널에 다음 명령어를 입력하세요:");
    console.error("   npm install express dotenv iconv-lite");
    process.exit(1);
}

const app = express();
const port = 3010;

// ------------------------------------------------------------------
// [Prisma 멀티 클라이언트 설정]
// ------------------------------------------------------------------
// 1. MySQL (조회 전용)
const prisma = new PrismaClient({ log: ['warn', 'error'] });

// 2. SQLite (주석 저장용)
// schema.sqlite.prisma에서 지정한 output 경로에서 가져옵니다.
const { PrismaClient: SQLitePrismaClient } = require('@prisma/client-sqlite');
const sqlitePrisma = new SQLitePrismaClient();

// ------------------------------------------------------------------
// [설정] 중요 테이블 목록 (상단 고정)
// ------------------------------------------------------------------
const IMPORTANT_TABLES = [
    't_cust', 't_cust_bae', 't_balju', 't_car', 't_code_basic', 't_product', 't_il_car'
];

// ------------------------------------------------------------------
// [핵심] 깨진 한글 복구 함수
// ------------------------------------------------------------------
function fixEncoding(str) {
    if (typeof str !== 'string') return str;
    try {
        return iconv.decode(Buffer.from(str, 'binary'), 'euc-kr');
    } catch (e) {
        return str;
    }
}

// 모든 응답에 UTF-8 헤더 적용
app.use((req, res, next) => {
    res.header('Content-Type', 'text/html; charset=utf-8');
    next();
});

// ------------------------------------------------------------------
// API 로직
// ------------------------------------------------------------------

app.get('/api/tables', (req, res) => {
    const tables = Object.keys(prisma).filter(key => !key.startsWith('_') && !key.startsWith('$'));

    // 중요 테이블 우선 정렬
    tables.sort((a, b) => {
        const isImportantA = IMPORTANT_TABLES.includes(a);
        const isImportantB = IMPORTANT_TABLES.includes(b);
        if (isImportantA && !isImportantB) return -1;
        if (!isImportantA && isImportantB) return 1;
        return a.localeCompare(b);
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(tables);
});

// ------------------------------------------------------------------
// [주석 관리 API - SQLite 사용]
// ------------------------------------------------------------------
app.get('/api/comments', async (req, res) => {
    const { table } = req.query;
    try {
        const comments = await sqlitePrisma.columnComment.findMany({
            where: { tableName: table }
        });

        // { columnName: comment } 형식으로 변환하여 프론트에 전달
        const commentMap = {};
        comments.forEach(c => {
            commentMap[c.columnName] = c.comment;
        });
        res.json(commentMap);
    } catch (e) {
        console.error("주석 조회 에러:", e);
        res.json({});
    }
});

app.post('/api/comments', express.json(), async (req, res) => {
    const { table, comments } = req.body;

    try {
        // 기존 주석 삭제 후 새로 입력 (또는 upsert 사용)
        // 여기서는 데이터가 많지 않으므로 순차적으로 upsert 처리
        for (const [col, msg] of Object.entries(comments)) {
            await sqlitePrisma.columnComment.upsert({
                where: {
                    tableName_columnName: {
                        tableName: table,
                        columnName: col
                    }
                },
                update: { comment: msg },
                create: {
                    tableName: table,
                    columnName: col,
                    comment: msg
                }
            });
        }
        res.json({ success: true });
    } catch (e) {
        console.error("주석 저장 에러:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/data', async (req, res) => {
    const { table, date } = req.query;

    try {
        if (!prisma[table]) return res.status(400).json({ error: "테이블 없음" });

        // DB 구조 직접 조회
        const columns = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM ${table}`);

        // 1. PK(고유키/인덱스) 찾기
        const pkInfo = columns.find(col => col.Key === 'PRI');
        const pkCol = pkInfo ? pkInfo.Field : null;

        // 2. 날짜 컬럼 결정 (필터링 용도로만 사용)
        let dateCol = null;
        const dateCandidates = columns.filter(col => {
            const type = col.Type.toLowerCase();
            const field = col.Field.toUpperCase();
            return type.includes('date') || type.includes('time') || field.includes('DATE');
        });

        if (dateCandidates.length > 0) {
            const priorityNames = ['REQDATE', 'B_DATE', 'I_DATE', 'O_DATE', 'TR_SENDDATE', 'REGDATE', 'INS_DATE'];
            const priority = dateCandidates.find(c => priorityNames.includes(c.Field.toUpperCase()));
            dateCol = priority ? priority.Field : dateCandidates[0].Field;
        }

        // -------------------------------------------------------
        // 조회 조건 생성 (WHERE) - 날짜 검색은 유지
        // -------------------------------------------------------
        let where = {};
        let searchDebugMsg = "";

        if (date && dateCol) {
            const targetColInfo = columns.find(c => c.Field === dateCol);

            if (targetColInfo) {
                const isDateTime = targetColInfo.Type.toLowerCase().includes('datetime') || targetColInfo.Type.toLowerCase().includes('timestamp');

                if (isDateTime) {
                    // DateTime 타입이면 범위 검색 (00:00 ~ 23:59)
                    const start = new Date(date);
                    const end = new Date(date);
                    end.setDate(end.getDate() + 1);
                    where[dateCol] = { gte: start, lt: end };
                    searchDebugMsg = `${date} (시간범위)`;
                } else {
                    // Varchar 타입이면 '2026-01-24' 와 '20260124' 둘 다 검색
                    const dateWithHyphen = date;
                    const dateNoHyphen = date.replace(/-/g, '');
                    where[dateCol] = { in: [dateWithHyphen, dateNoHyphen] };
                    searchDebugMsg = `"${dateWithHyphen}" 또는 "${dateNoHyphen}"`;
                }
            }
        }

        // -------------------------------------------------------
        // 정렬 조건 (ORDER BY) - 무조건 인덱스(PK) 내림차순
        // -------------------------------------------------------
        let orderBy = [];

        // 사용자의 요청대로 날짜 정렬은 배제하고, PK가 있으면 PK 역순으로만 정렬합니다.
        if (pkCol) {
            orderBy.push({ [pkCol]: 'desc' });
        }

        // -------------------------------------------------------
        // 데이터 조회 실행
        // -------------------------------------------------------
        let data = [];
        let isFallback = false;

        // 1차 시도: 날짜 조건 넣고 검색
        if (Object.keys(where).length > 0) {
            data = await prisma[table].findMany({
                where: where,
                take: 1000,
                orderBy: orderBy.length > 0 ? orderBy : undefined
            });
        }

        // 2차 시도: 검색 결과 없으면 조건 없이 인덱스 최신순 조회
        if (data.length === 0) {
            isFallback = true;
            data = await prisma[table].findMany({
                where: {},
                take: 1000, // 데이터 확인용 1000건 표시
                orderBy: orderBy.length > 0 ? orderBy : undefined
            });
            searchDebugMsg = "조건 없음 (전체 최신순 10건)";
        }

        // 한글 변환
        data = data.map(row => {
            const newRow = {};
            for (const key in row) {
                let val = row[key];
                if (typeof val === 'string') newRow[key] = fixEncoding(val);
                else newRow[key] = val;
            }
            return newRow;
        });

        // 결과 전송
        const jsonString = JSON.stringify({
            data,
            columns: columns.map(c => c.Field), // 전체 컬럼 정보 추가 반환
            dateCol,
            pkCol,
            debug: `결과: ${isFallback ? '⚠️ 검색실패 -> 전체조회' : '✅ 날짜검색 성공'} (${searchDebugMsg}), 정렬: ${pkCol ? pkCol + ' (내림차순)' : '기본'}`
        }, (key, value) => typeof value === 'bigint' ? value.toString() : value);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(jsonString);

    } catch (e) {
        console.error(e);
        res.status(500).send(JSON.stringify({ error: "에러: " + e.message }));
    }
});

// ------------------------------------------------------------------
// HTML 화면
// ------------------------------------------------------------------
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SME 데이터 뷰어 (PK 정렬)</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 p-6">
    <div class="max-w-7xl mx-auto bg-white shadow rounded-lg p-6">
        <h1 class="text-2xl font-bold mb-6 text-gray-800">📊 내 DB 조회기 (인덱스 정렬 Ver)</h1>
        
        <div class="flex flex-wrap gap-4 mb-6 bg-gray-50 p-4 rounded border">
            <div class="flex-1">
                <label class="block text-sm font-bold text-gray-700 mb-1">테이블 선택</label>
                <select id="tableSelect" class="w-full border p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"></select>
            </div>
            <div class="w-48">
                <label class="block text-sm font-bold text-gray-700 mb-1">날짜 선택</label>
                <input type="date" id="dateInput" class="w-full border p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500">
            </div>
            <div class="flex items-end gap-2">
                <button onclick="loadData()" class="bg-indigo-600 text-white font-bold py-2 px-6 rounded hover:bg-indigo-700 transition shadow-md">조회</button>
                <button onclick="saveComments()" class="bg-green-600 text-white font-bold py-2 px-6 rounded hover:bg-green-700 transition shadow-md">주석 저장</button>
            </div>
        </div>

        <div class="flex justify-between items-center mb-2">
            <div id="statusMsg" class="text-sm text-gray-600">테이블을 선택해주세요.</div>
            <div id="debugMsg" class="text-xs text-gray-400"></div>
        </div>
        
        <div class="overflow-x-auto border rounded bg-white h-[calc(100vh-250px)] overflow-y-auto relative">
            <table class="min-w-full divide-y divide-gray-200 relative">
                <thead class="bg-gray-100 sticky top-0 z-10 shadow-sm" id="tableHead"></thead>
                <tbody class="divide-y divide-gray-200 text-sm" id="tableBody"></tbody>
            </table>
        </div>
    </div>

    <script>
        fetch('/api/tables')
            .then(res => res.json())
            .then(tables => {
                const select = document.getElementById('tableSelect');
                select.innerHTML = tables.map(t => '<option value="' + t + '">' + t + '</option>').join('');
                document.getElementById('dateInput').valueAsDate = new Date();
            });

        async function loadData() {
            const table = document.getElementById('tableSelect').value;
            const date = document.getElementById('dateInput').value;
            const status = document.getElementById('statusMsg');
            const debug = document.getElementById('debugMsg');
            const thead = document.getElementById('tableHead');
            const tbody = document.getElementById('tableBody');

            if (!table) return;
            status.textContent = '🔍 데이터 조회 중...';
            tbody.innerHTML = '';
            thead.innerHTML = '';
            debug.textContent = '';

            try {
                // 1. 데이터 조회
                const res = await fetch('/api/data?table=' + table + '&date=' + date);
                const json = await res.json();
                
                // 2. 주석 조회
                const cRes = await fetch('/api/comments?table=' + table);
                const comments = await cRes.json();

                if (json.error) {
                    status.innerHTML = '<span class="text-red-600">⚠️ ' + json.error + '</span>';
                    return;
                }

                const data = json.data;
                const columnNames = json.columns || []; // 서버에서 받은 컬럼 목록 사용
                debug.textContent = json.debug; 

                // 데이터가 없어도 헤더 + 주석 입력칸 그리기
                // Row 1: 컬럼명
                let headHtml = '<tr>' + columnNames.map(col => {
                    const isPk = col === json.pkCol;
                    const isDate = col === json.dateCol;
                    let style = 'text-gray-600';
                    if (isPk) style = 'text-indigo-700 font-bold bg-indigo-50';
                    if (isDate) style = 'text-green-700 font-bold bg-green-50';
                    return '<th class="px-3 py-2 text-left whitespace-nowrap ' + style + '">' + col + (isPk ? '🔑' : '') + '</th>';
                }).join('') + '</tr>';

                // Row 2: 주석 입력
                headHtml += '<tr class="bg-gray-50 border-b border-gray-200">' + columnNames.map(col => {
                    const val = comments[col] || '';
                    return '<td class="p-1"><input type="text" data-col="' + col + '" value="' + val + '" class="comment-input w-full text-xs p-1 border rounded bg-yellow-50 focus:bg-white focus:outline-none focus:border-indigo-500" placeholder="주석.."></td>';
                }).join('') + '</tr>';
                
                thead.innerHTML = headHtml;

                if (data.length === 0) {
                    status.innerHTML = '<span class="text-orange-600">데이터가 없습니다. (테이블 구조만 표시됨)</span>';
                    tbody.innerHTML = '<tr><td colspan="' + columnNames.length + '" class="p-4 text-center text-gray-400">데이터가 존재하지 않습니다.</td></tr>';
                    return;
                }

                status.innerHTML = '총 <strong>' + data.length + '</strong>건 조회됨';

                tbody.innerHTML = data.map(row => {
                    return '<tr class="hover:bg-gray-50 transition">' + columnNames.map(col => {
                        let val = row[col];
                        if (val === null || val === undefined) val = '<span class="text-gray-300">-</span>';
                        return '<td class="px-3 py-2 text-gray-700 whitespace-nowrap border-r border-gray-100 last:border-0">' + val + '</td>';
                    }).join('') + '</tr>';
                }).join('');

            } catch (e) {
                status.textContent = '통신 에러가 발생했습니다.';
                console.error(e);
            }
        }

        async function saveComments() {
            const table = document.getElementById('tableSelect').value;
            if (!table) return alert("테이블을 선택해주세요.");

            const inputs = document.querySelectorAll('.comment-input');
            const comments = {};
            inputs.forEach(input => {
                const col = input.getAttribute('data-col');
                const val = input.value.trim();
                if (val) comments[col] = val; // 값이 있는 것만 저장
            });

            try {
                const res = await fetch('/api/comments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ table, comments })
                });
                const json = await res.json();
                if (json.success) alert("주석이 저장되었습니다! ✅");
                else alert("저장 실패 ❌");
            } catch(e) {
                console.error(e);
                alert("통신 오류");
            }
        }
    </script>
</body>
</html>
`);
});

app.listen(port, () => {
    console.log("==================================================");
    console.log(" 🚀 웹 DB 조회기 (PK 정렬 Ver) 실행됨!");
    console.log(" 👉 http://localhost:" + port);
    console.log("==================================================");
});
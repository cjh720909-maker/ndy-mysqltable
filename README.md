# SME DB Viewer

웹 기반의 데이터베이스 조회 도구입니다.

## 주요 기능
- **데이터 조회**: 테이블별 1000건의 데이터를 PK 내림차순으로 조회
- **날짜 필터링**: 특정 날짜의 데이터를 검색 (문자열 및 DateTime 형식 지원)
- **컬럼 주석**: 각 테이블 컬럼에 대한 주석을 작성하고 저장하는 기능
- **중요 테이블 우선순위**: `t_cust`, `t_cust_bae` 등 주요 테이블 상단 배치

## 실행 방법
1. **의존성 설치**
   ```bash
   npm install
   ```
2. **환경 변수 설정**
   `.env` 파일을 생성하고 아래 내용을 입력합니다.
   ```text
   DATABASE_URL="mysql://유저:비밀번호@호스트:포트/데이터베이스"
   ```
3. **서버 실행**
   ```bash
   node web_db_viewer.js
   ```
   또는 `run_db_viewer.bat` 실행

## 기술 스택
- Node.js / Express
- Prisma (ORM)
- Tailwind CSS
- iconv-lite (한글 인코딩 처리)

import { judgePageLanguage } from "../core/pageLanguage.js";

/** Cases for "can we read this page at all?".  npm run test:language */
let pass = 0, fail = 0;
const check = (n: string, c: boolean, got?: unknown) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${got===undefined?"":` — got ${JSON.stringify(got)}`}`); }
};

// Verbatim from the capture that exposed this.
const THAI = "กลับไปที่การลงประกาศรับสมัครงาน Summer 2027 Internship: Data Engineering (Ardmore, OK) ข้อมูลของฉัน ประสบการณ์ของฉัน คำถามในการสมัครงาน 1/2 คำถามในการสมัครงาน 2/2 การเปิดเผยโดยสมัครใจ การรับรองด้วยตนเอง ระบุฟิลด์ที่จำเป็น คุณได้รับทราบข่าวเกี่ยวกับเราได้อย่างไร LinkedIn คุณเคยได้รับการว่าจ้างจากบริษัทมิชลินหรือบริษัทในเครือของมิชลินมาก่อนหรือไม่ ใช่ ไม่ใช่ ประเทศ/ดินแดน สหรัฐอเมริกา ชื่อตามบัตรประชาชน";
const ENGLISH = "Back to Job Posting Summer 2027 Internship: Data Engineering (Ardmore, OK) My Information My Experience Application Questions 1/2 Application Questions 2/2 Voluntary Disclosures Self Identify indicates a required field How Did You Hear About Us? Have you ever been employed by Michelin or one of its subsidiaries? Yes No Country/Territory United States of America Legal Name First Name Last Name";

console.log("the page that broke this");
const thai = judgePageLanguage(THAI);
check(`the Thai capture is NOT readable`, !thai.readable, thai.latinShare.toFixed(2));
check(`and its Latin share is tiny`, thai.latinShare < 0.2, thai.latinShare.toFixed(2));
check(`the same form in English IS readable`, judgePageLanguage(ENGLISH).readable);

console.log("\nwhat must not be mistaken for the wrong language");
check(`an English form with a non-Latin name in it`,
  judgePageLanguage(ENGLISH + " Candidate: 山田太郎").readable);
check(`a page still rendering (too little text to judge)`, judgePageLanguage("Loading…").readable);
check(`an empty page`, judgePageLanguage("").readable);
// French shares the alphabet: the URL rewrite handles it, and this must not claim to.
check(`French is readable BY THIS TEST — the URL rewrite is what catches it`,
  judgePageLanguage("Postuler Ouvrir une session Mes informations Prénom Nom de famille Pays ou territoire Adresse électronique requise").readable);
for (const [name, text] of [
  ["Japanese", "応募する ログイン 私の情報 名 姓 国または地域 メールアドレス 必須項目です 応募内容の確認 職務経歴 学歴 スキル"],
  ["Chinese", "申请 登录 我的信息 名字 姓氏 国家或地区 电子邮件地址 必填字段 工作经历 教育背景 技能 提交申请"],
  ["Korean", "지원하기 로그인 내 정보 이름 성 국가 또는 지역 이메일 주소 필수 항목 경력 사항 학력 기술 지원서 제출"],
] as const) check(`${name} is not readable`, !judgePageLanguage(text).readable, judgePageLanguage(text).latinShare.toFixed(2));

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

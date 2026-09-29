import {
  verifyMailer,
  sendPasswordResetCode,
} from "./mailer.js";

const to = process.env.MAIL_TEST_TO;

if (!to) {
  throw new Error("Thiếu MAIL_TEST_TO trong .env");
}

console.log("Đang kiểm tra SMTP...");

await verifyMailer();

console.log("SMTP OK.");
console.log("Đang gửi email test tới:", to);

const result = await sendPasswordResetCode({
  to,
  code: "482193",
  expiresInMinutes: 15,
});

console.log("Gửi email thành công.");
console.log("messageId:", result.messageId);
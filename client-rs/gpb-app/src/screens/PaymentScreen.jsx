import { QRCodeSVG } from "qrcode.react";

function formatMoney(amount) {
  return new Intl.NumberFormat(
    "vi-VN",
    {
      style: "currency",
      currency: "VND",
      maximumFractionDigits: 0,
    },
  ).format(amount ?? 0);
}

export default function PaymentScreen({
  checkout,
  onBack,
}) {
  const order = checkout?.order;
  const payment = checkout?.payment;

  if (!order || !payment) {
    return (
      <section className="screen">
        <p className="error">
          Không có thông tin thanh toán.
        </p>

        <button
          className="btn ghost"
          onClick={onBack}
        >
          Quay lại
        </button>
      </section>
    );
  }

  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <h1>Thanh toán</h1>

          <p className="tag">
            Quét mã bằng ứng dụng ngân hàng
          </p>
        </div>

        <button
          type="button"
          className="btn ghost sm"
          onClick={onBack}
        >
          Quay lại
        </button>
      </header>

      <div className="payment-card">
        <div className="payment-qr">
          <QRCodeSVG
            value={payment.qrCode}
            size={220}
            level="M"
          />
        </div>

        <h2>
          {formatMoney(order.amount)}
        </h2>

        <p>
          {order.plan?.name}
        </p>

        <div className="status-row">
          <span className="label">
            Mã đơn
          </span>

          <span className="value">
            {order.orderCode}
          </span>
        </div>

        <div className="status-row">
          <span className="label">
            Trạng thái
          </span>

          <span className="value">
            Đang chờ thanh toán
          </span>
        </div>

        <a
          className="btn primary"
          href={payment.checkoutUrl}
          target="_blank"
          rel="noreferrer"
        >
          Mở trang thanh toán
        </a>
      </div>
    </section>
  );
}
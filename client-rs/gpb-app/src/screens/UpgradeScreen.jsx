import {
  useEffect,
  useState,
} from "react";

import {
  apiBillingPlans,
  apiBillingCheckout,
  errMsg,
} from "../api.js";

import logo from "../assets/goslynk-mark.png";

function formatMoney(amount, currency) {
  if (currency === "VND") {
    return new Intl.NumberFormat(
      "vi-VN",
      {
        style: "currency",
        currency: "VND",
        maximumFractionDigits: 0,
      },
    ).format(amount);
  }

  return new Intl.NumberFormat(
    undefined,
    {
      style: "currency",
      currency,
    },
  ).format(amount);
}

export default function UpgradeScreen({
  onBack,
  onCheckoutReady,
}) {
  const [plans, setPlans] =
    useState([]);

  const [busy, setBusy] =
    useState(true);

  const [error, setError] =
    useState("");

  const [checkoutPlan, setCheckoutPlan] =
    useState("");

  useEffect(() => {
    let cancelled = false;

    apiBillingPlans()
      .then((data) => {
        if (cancelled) {
          return;
        }

        setPlans(
          Array.isArray(data.plans)
            ? data.plans
            : [],
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errMsg(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSelectPlan(plan) {
    if (checkoutPlan) {
        return;
    }

    setError("");
    setCheckoutPlan(plan.code);

    try {
        const data =
        await apiBillingCheckout(
            plan.code,
        );

        onCheckoutReady?.(data);
    } catch (err) {
        setError(errMsg(err));
    } finally {
        setCheckoutPlan("");
    }
  }

  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <img
            className="brand-logo"
            src={logo}
            alt=""
          />

          <h1>Nâng cấp Goslynk</h1>

          <p className="tag">
            Chọn gói phù hợp với bạn
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

      {busy ? (
        <p className="hint muted">
          Đang tải các gói...
        </p>
      ) : null}

      {error ? (
        <p className="error">
          {error}
        </p>
      ) : null}

      {!busy &&
      !error &&
      plans.length === 0 ? (
        <p className="notice warn">
          Hiện chưa có gói nào khả dụng.
        </p>
      ) : null}

      <div className="billing-plan-list">
        {plans.map((plan) => {
          const price =
            plan.price ?? {};

          return (
            <article
              className="billing-plan"
              key={plan.id}
            >
              <div className="billing-plan-head">
                <div>
                  <h2 className="billing-plan-name">
                    {plan.name}
                  </h2>

                  <p className="hint">
                    {plan.description}
                  </p>
                </div>

                {plan.code === "quarterly" ? (
                  <span className="billing-badge">
                    Phổ biến
                  </span>
                ) : null}
              </div>

              <div className="billing-price">
                {formatMoney(
                  price.amount ?? 0,
                  price.currency ?? "VND",
                )}
              </div>

              <div className="billing-details">
                <div className="status-row">
                  <span className="label">
                    Thời hạn
                  </span>

                  <span className="value">
                    {plan.durationDays} ngày
                  </span>
                </div>

                <div className="status-row">
                  <span className="label">
                    Thiết bị
                  </span>

                  <span className="value">
                    {plan.deviceLimit}
                  </span>
                </div>

                <div className="status-row">
                  <span className="label">
                    Thanh toán
                  </span>

                  <span className="value">
                    VietQR
                  </span>
                </div>
              </div>

              <button
                type="button"
                className="btn primary"
                disabled={Boolean(checkoutPlan)}
                onClick={() =>
                    handleSelectPlan(plan)
                }
              >
                {checkoutPlan === plan.code
                    ? "Đang tạo thanh toán..."
                    : `Chọn gói ${plan.name}`}
              </button>

            </article>
          );
        })}
      </div>

      <p className="hint muted">
        Giá và thời hạn được lấy trực tiếp
        từ hệ thống Goslynk.
      </p>
    </section>
  );
}
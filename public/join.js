// Public trial request form. Every request becomes a real lead in the ledger.
(() => {
  "use strict";
  const form = document.getElementById("join-form");
  const msg = document.getElementById("join-msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    msg.textContent = "";
    try {
      const res = await fetch("/api/public/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
      form.reset();
      msg.style.color = "#1f8a4c";
      msg.textContent = "Thank you! We will contact you soon.";
    } catch (err) {
      msg.style.color = "";
      msg.textContent = err.message;
    }
    btn.disabled = false;
  });
})();

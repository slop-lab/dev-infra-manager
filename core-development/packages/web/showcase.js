const standardPatchLines = [
  ["hunk", "@@ -18,7 +18,15 @@ export function renderPolicy(input) {"],
  ["context", "   const policy = parsePolicy(input);"],
  ["del", "-  return container.innerHTML = policy.summary;"],
  ["add", "+  const summary = document.createElement(\"span\");"],
  ["add", "+  summary.textContent = policy.summary;"],
  ["add", "+  container.replaceChildren(summary);"],
  ["context", " }"],
  ["context", ""],
  ["add", "+// Untrusted sample: <script>window.secret = true</script>"],
];

const cjkPatchLines = [
  ["hunk", "@@ -18,7 +18,15 @@ export function renderPolicy(input) {"],
  ["context", "   const 설명 = \"검토 증거\";"],
  ["del", "-  return container.innerHTML = policy.summary;"],
  ["add", "+  const message = \"승인 전 정확한 증거를 다시 확인합니다.\";"],
  ["add", "+  const 状態 = \"承認前の証拠を確認\";"],
  ["add", "+  const 说明 = \"完整树证据必须保持可读\";"],
  ["context", " }"],
];

const stateContent = {
  loading: `
    <div class="state-content" role="status" aria-label="Loading review queue">
      <span class="spinner" aria-hidden="true"></span>
      <h3 tabindex="-1">Loading review queue</h3>
      <div class="skeleton" aria-hidden="true"></div>
      <div class="skeleton skeleton-short" aria-hidden="true"></div>
    </div>`,
  empty: `
    <div class="state-content">
      <span class="state-symbol" aria-hidden="true">0</span>
      <h3 tabindex="-1">No reviews need attention</h3>
      <p>The queue is current. New exact-evidence proposals will appear here.</p>
      <button class="button button-secondary" type="button" data-refresh>Refresh queue</button>
    </div>`,
  error: `
    <div class="state-content" role="alert">
      <span class="state-symbol" aria-hidden="true">!</span>
      <h3 tabindex="-1">Review queue could not be loaded</h3>
      <p>Your session is unchanged. Check the connection, then retry.</p>
      <button class="button button-secondary" type="button" data-retry>Retry</button>
    </div>`,
};

const patchCode = document.querySelector("#patch-code");
const patchRegion = document.querySelector(".patch-region");
const patchScrollCue = document.querySelector("#patch-scroll-cue");
const patchScrollIndicator = document.querySelector(".patch-scroll-indicator");

function renderPatch(lines) {
  const fragment = document.createDocumentFragment();
  for (const [kind, text] of lines) {
    const line = document.createElement("span");
    line.className = `patch-line patch-line-${kind}`;
    line.textContent = text || " ";
    fragment.append(line);
  }
  patchCode.replaceChildren(fragment);
  window.requestAnimationFrame(updatePatchScrollCue);
}

function updatePatchScrollCue() {
  const hasOverflow = patchRegion.scrollWidth > patchRegion.clientWidth;
  patchScrollCue.hidden = !hasOverflow;
  patchScrollIndicator.hidden = !hasOverflow;
  if (!hasOverflow) {
    patchScrollIndicator.style.setProperty("--patch-thumb-size", "100%");
    patchScrollIndicator.style.setProperty("--patch-thumb-start", "0%");
    return;
  }

  const atEnd = patchRegion.scrollLeft + patchRegion.clientWidth >= patchRegion.scrollWidth - 1;
  const position = atEnd ? "end" : patchRegion.scrollLeft > 0 ? "middle" : "start";
  patchScrollCue.textContent = `Horizontal scroll available. Position: ${position}. Focus the patch and use Left or Right Arrow.`;
  patchScrollIndicator.style.setProperty("--patch-thumb-size", `${(patchRegion.clientWidth / patchRegion.scrollWidth) * 100}%`);
  patchScrollIndicator.style.setProperty("--patch-thumb-start", `${(patchRegion.scrollLeft / patchRegion.scrollWidth) * 100}%`);
  patchScrollIndicator.dataset.position = position;
}

patchRegion.addEventListener("scroll", updatePatchScrollCue);
window.addEventListener("resize", updatePatchScrollCue);
renderPatch(standardPatchLines);

const loginForm = document.querySelector("#login-form");
const email = document.querySelector("#email");
const password = document.querySelector("#password");
const loginButton = document.querySelector("#login-submit");
const loginButtonLabel = loginButton.querySelector(".button-label");
const loginStatus = document.querySelector("#login-status");
let loginPending = false;

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (loginPending) return;

  const emailValid = email.validity.valid && email.value.length > 0;
  const passwordValid = password.value.length >= 8;

  email.setAttribute("aria-invalid", String(!emailValid));
  password.setAttribute("aria-invalid", String(!passwordValid));
  document.querySelector("#email-error").textContent = emailValid ? "" : "Enter a complete email address.";
  document.querySelector("#password-error").textContent = passwordValid ? "" : "Enter at least eight characters.";

  if (!emailValid || !passwordValid) {
    (emailValid ? password : email).focus();
    loginStatus.textContent = "Sign-in demo was not submitted. Correct the marked fields.";
    return;
  }

  loginPending = true;
  loginButton.classList.add("is-loading");
  loginButton.setAttribute("aria-busy", "true");
  loginButton.setAttribute("aria-disabled", "true");
  loginButtonLabel.textContent = "Checking";
  loginStatus.textContent = "Checking local demo input.";
  window.setTimeout(() => {
    loginPending = false;
    loginButton.classList.remove("is-loading");
    loginButton.removeAttribute("aria-busy");
    loginButton.removeAttribute("aria-disabled");
    loginButtonLabel.textContent = "Sign in";
    loginStatus.textContent = "Local demo complete. No credentials were sent or stored.";
  }, 450);
});

const decisionBadge = document.querySelector("#decision-badge");
const decisionStatus = document.querySelector("#decision-status");
const approveButton = document.querySelector("#approve-button");
const revokeButton = document.querySelector("#revoke-button");

approveButton.addEventListener("click", () => {
  decisionBadge.className = "badge badge-approved";
  decisionBadge.innerHTML = '<span class="status-marker" aria-hidden="true"></span>Approved';
  decisionStatus.textContent = "Local showcase state only. A production action would revalidate exact evidence.";
  approveButton.disabled = true;
  revokeButton.disabled = false;
  revokeButton.focus();
});

revokeButton.addEventListener("click", () => {
  decisionBadge.className = "badge badge-error";
  decisionBadge.innerHTML = '<span class="status-marker" aria-hidden="true"></span>Revoked';
  decisionStatus.textContent = "Local showcase approval revoked. No server state was changed.";
  approveButton.disabled = false;
  revokeButton.disabled = true;
  approveButton.focus();
});

const stressToggle = document.querySelector("#stress-toggle");
const cjkToggle = document.querySelector("#cjk-toggle");

function updateEvidenceContent() {
  const usesLongContent = stressToggle.getAttribute("aria-pressed") === "true";
  const usesCjkContent = cjkToggle.getAttribute("aria-pressed") === "true";

  document.querySelector("#patch-path").textContent = usesCjkContent
    ? "packages/reviewer/src/검토/証拠/完整树/정책.ts"
    : usesLongContent
      ? "packages/controller/src/review-boundaries/a-very-long-directory-name-without-shortcuts/revalidate-complete-tree-proposal-before-authorized-approval.ts"
      : "packages/controller/src/policy.ts";
  document.querySelector("#expected-head").textContent = usesLongContent
    ? "7c21a93b99d10fe6c6c953b5f2b9d9a1d33eb2cad34f167790e549feb12cc0fe"
    : "7c21a93";
  document.querySelector("#file-summary").textContent = usesCjkContent
    ? "追加 12件, 削除 4件 · 검토 증거"
    : "12 additions, 4 deletions";
  document.querySelector("#project-value").textContent = usesCjkContent ? "개발-검토" : "dim-dev";
  document.querySelector("#reviewer-value").textContent = usesCjkContent ? "ホスト審査員" : "host-reviewer";
  renderPatch(usesCjkContent ? cjkPatchLines : standardPatchLines);
}

stressToggle.addEventListener("click", () => {
  const isStressed = stressToggle.getAttribute("aria-pressed") === "true";
  stressToggle.setAttribute("aria-pressed", String(!isStressed));
  stressToggle.textContent = isStressed ? "Use long content" : "Use standard content";
  updateEvidenceContent();
});

cjkToggle.addEventListener("click", () => {
  const usesCjkContent = cjkToggle.getAttribute("aria-pressed") === "true";
  cjkToggle.setAttribute("aria-pressed", String(!usesCjkContent));
  cjkToggle.textContent = usesCjkContent ? "Use CJK content" : "Use standard language";
  updateEvidenceContent();
});

const statePanel = document.querySelector("#state-panel");
const stateChoices = [...document.querySelectorAll(".state-choice")];

function showState(state) {
  statePanel.innerHTML = stateContent[state];
  for (const choice of stateChoices) {
    choice.setAttribute("aria-pressed", String(choice.dataset.state === state));
  }
  statePanel.querySelector("[data-retry], [data-refresh]")?.addEventListener("click", () => {
    showState("loading");
    window.setTimeout(() => {
      showState("empty");
      statePanel.querySelector("h3").focus({ preventScroll: true });
    }, 450);
  });
}

for (const choice of stateChoices) {
  choice.addEventListener("click", () => showState(choice.dataset.state));
}

showState("empty");

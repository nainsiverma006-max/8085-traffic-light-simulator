"use strict";

const T_STATES_PER_PASS = 1_572_864;
const CRYSTAL_MHZ = 6;

const phases = [
  { key: "green", name: "Green", port: 0x41, seconds: 7 },
  { key: "yellow", name: "Yellow", port: 0x84, seconds: 2 },
  { key: "red", name: "Red", port: 0x90, seconds: 10 }
];

const program = [
  { id: "setup-sp", address: "2000H", op: "setup" },
  { id: "green-load", address: "2003H", op: "load-port", phase: "green" },
  { id: "green-out", address: "2005H", op: "out" },
  { id: "green-count", address: "2007H", op: "load-count", phase: "green" },
  { id: "green-call", address: "2009H", op: "call" },
  { id: "yellow-load", address: "200CH", op: "load-port", phase: "yellow" },
  { id: "yellow-out", address: "200EH", op: "out" },
  { id: "yellow-count", address: "2010H", op: "load-count", phase: "yellow" },
  { id: "yellow-call", address: "2012H", op: "call" },
  { id: "red-load", address: "2015H", op: "load-port", phase: "red" },
  { id: "red-out", address: "2017H", op: "out" },
  { id: "red-count", address: "2019H", op: "load-count", phase: "red" },
  { id: "red-call", address: "201BH", op: "call" },
  { id: "jmp-start", address: "201EH", op: "jump-start" },
  { id: "push-psw", address: "2021H", op: "push-psw" },
  { id: "push-d", address: "2022H", op: "push-d" },
  { id: "mov-a-b", address: "2023H", op: "mov-a-b" },
  { id: "add-a", address: "2024H", op: "add-a" },
  { id: "mov-b-a", address: "2025H", op: "mov-b-a" },
  { id: "lxi-d", address: "2028H", op: "lxi-d" },
  { id: "dcx-d", address: "202BH", op: "dcx-d" },
  { id: "mov-a-d", address: "202CH", op: "mov-a-d" },
  { id: "ora-e", address: "202DH", op: "ora-e" },
  { id: "jnz-inner", address: "202EH", op: "jnz-inner" },
  { id: "dcr-b", address: "2031H", op: "dcr-b" },
  { id: "jnz-outer", address: "2032H", op: "jnz-outer" },
  { id: "pop-d", address: "2035H", op: "pop-d" },
  { id: "pop-psw", address: "2036H", op: "pop-psw" },
  { id: "ret", address: "2037H", op: "ret" }
];

const indexById = new Map(program.map((instruction, index) => [instruction.id, index]));
const phaseByKey = new Map(phases.map((phase) => [phase.key, phase]));

const elements = {
  welcomeScreen: document.getElementById("welcome-screen"),
  simulatorApp: document.getElementById("simulator-app"),
  enterSimulator: document.getElementById("enter-simulator"),
  themeToggle: document.getElementById("theme-toggle"),
  phaseBadge: document.getElementById("phase-badge"),
  phaseName: document.getElementById("phase-name"),
  phaseTime: document.getElementById("phase-time"),
  portHex: document.getElementById("port-hex"),
  portBinary: document.getElementById("port-binary"),
  executionState: document.getElementById("execution-state"),
  runButton: document.getElementById("run-button"),
  pauseButton: document.getElementById("pause-button"),
  stepButton: document.getElementById("step-button"),
  resetButton: document.getElementById("reset-button"),
  speedSlider: document.getElementById("speed-slider"),
  speedValue: document.getElementById("speed-value"),
  modeToggle: document.getElementById("mode-toggle"),
  modeLabel: document.getElementById("mode-label"),
  registers: {
    a: document.getElementById("reg-a"),
    b: document.getElementById("reg-b"),
    d: document.getElementById("reg-d"),
    e: document.getElementById("reg-e"),
    sp: document.getElementById("reg-sp"),
    pc: document.getElementById("reg-pc")
  },
  countdown: document.getElementById("countdown-value"),
  bits: [...document.querySelectorAll(".bit-cell")],
  lamps: {
    red: document.getElementById("lamp-red"),
    yellow: document.getElementById("lamp-yellow"),
    green: document.getElementById("lamp-green")
  },
  walk: document.getElementById("walk-indicator"),
  dontWalk: document.getElementById("dont-walk-indicator"),
  timeline: [...document.querySelectorAll(".timeline-segment")],
  secondsInput: document.getElementById("seconds-input"),
  frequencyInput: document.getElementById("frequency-input"),
  clockValue: document.getElementById("clock-value"),
  loopCount: document.getElementById("loop-count"),
  effectiveCount: document.getElementById("effective-count"),
  tStates: document.getElementById("t-states"),
  actualDelay: document.getElementById("actual-delay"),
  calculatorMessage: document.getElementById("calculator-message")
};

let state;
let running = false;
let fastMode = false;
let timerId = null;
let timerDueAt = 0;
let pendingWork = null;
let remainingDelay = 0;
let progressTimerId = null;
let phaseStartedAt = null;
let phaseElapsedMs = 0;
let phaseTimerActive = false;
let completedPhases = new Set();
let activePhaseKey = null;
let savedA = 0;
let savedDE = 0;
let callStack = [];

function freshState() {
  return { a: 0, b: 0, d: 0, e: 0, sp: 0x1234, port: 0, pcIndex: 0, currentId: null };
}

function hexByte(value) {
  return `${(value & 0xFF).toString(16).toUpperCase().padStart(2, "0")}H`;
}

function hexWord(value) {
  return `${(value & 0xFFFF).toString(16).toUpperCase().padStart(4, "0")}H`;
}

function speedFactor() {
  return [1, 10, 100][Number(elements.speedSlider.value)];
}

function animationDelay() {
  return Math.max(1, (fastMode ? 3 : 1) / speedFactor());
}

function outerPassDelayMs() {
  if (fastMode) return 35 / speedFactor();
  const clockHz = CRYSTAL_MHZ * 1_000_000 / 2;
  return T_STATES_PER_PASS / clockHz * 1000 / speedFactor();
}

function updatePhaseReadout() {
  const phase = phaseByKey.get(activePhaseKey);
  if (!phase) {
    elements.phaseName.textContent = "Waiting to start";
    elements.phaseTime.textContent = "—";
    elements.phaseBadge.removeAttribute("data-phase");
    elements.phaseBadge.innerHTML = '<span class="status-dot"></span> Ready';
    return;
  }

  const actual = phase.seconds * 2 * T_STATES_PER_PASS / (CRYSTAL_MHZ * 500_000);
  elements.phaseName.textContent = `${phase.name} · ${phase.key === "green" ? "WALK" : "DON'T WALK"}`;
  elements.phaseTime.textContent = `${phase.seconds}s / ${actual.toFixed(2)}s`;
  elements.phaseBadge.dataset.phase = phase.key;
  elements.phaseBadge.innerHTML = `<span class="status-dot"></span> ${phase.name}`;
}

function updateSignals() {
  const on = (bit) => Boolean(state.port & (1 << bit));
  for (const [name, bit] of [["red", 4], ["yellow", 2], ["green", 0]]) {
    const isOn = on(bit);
    elements.lamps[name].classList.toggle("is-on", isOn);
    elements.lamps[name].setAttribute("aria-label", `${name[0].toUpperCase()}${name.slice(1)} lamp ${isOn ? "on" : "off"}`);
  }

  const walkOn = on(6);
  const dontWalkOn = on(7);
  elements.walk.classList.toggle("is-on", walkOn);
  elements.dontWalk.classList.toggle("is-on", dontWalkOn);
  elements.walk.setAttribute("aria-label", `WALK ${walkOn ? "on" : "off"}`);
  elements.dontWalk.setAttribute("aria-label", `DON'T WALK ${dontWalkOn ? "on" : "off"}`);
  elements.portHex.textContent = hexByte(state.port);
  elements.portBinary.textContent = state.port.toString(2).padStart(8, "0");

  for (const cell of elements.bits) {
    const bit = Number(cell.dataset.bit);
    const isOn = on(bit);
    const label = cell.querySelector(".bit-name").textContent.trim().replace(/\s+/g, " ");
    cell.classList.toggle("is-on", isOn);
    cell.setAttribute("aria-label", `D${bit}${label ? ` ${label}` : ""}: ${isOn ? "on" : "off"}`);
  }
  updatePhaseReadout();
}

function updateRegisters() {
  elements.registers.a.textContent = hexByte(state.a);
  elements.registers.b.textContent = hexByte(state.b);
  elements.registers.d.textContent = hexByte(state.d);
  elements.registers.e.textContent = hexByte(state.e);
  elements.registers.sp.textContent = hexWord(state.sp);
  elements.registers.pc.textContent = program[state.pcIndex]?.address ?? "2000H";

  const delayStart = indexById.get("push-psw");
  const delayEnd = indexById.get("ret");
  const inDelay = state.pcIndex >= delayStart && state.pcIndex <= delayEnd;
  elements.countdown.textContent = inDelay ? `${state.b} pass${state.b === 1 ? "" : "es"}` : "—";
}

function updateCodeHighlight() {
  document.querySelectorAll(".instruction.is-current").forEach((node) => node.classList.remove("is-current"));
  if (state.currentId) document.getElementById(`ins-${state.currentId}`).classList.add("is-current");
}

function updateExecutionControls() {
  elements.executionState.textContent = running ? "Running" : (state.currentId ? "Paused" : "Ready");
  elements.executionState.dataset.state = running ? "running" : (state.currentId ? "paused" : "ready");
  elements.runButton.disabled = running;
  elements.pauseButton.disabled = !running;
  elements.stepButton.disabled = running;
}

function updateTimeline() {
  const phase = phaseByKey.get(activePhaseKey);
  let phaseProgress = 0;
  if (phase && phaseTimerActive) {
    const elapsedMs = phaseElapsedMs + (phaseStartedAt === null ? 0 : performance.now() - phaseStartedAt);
    const elapsed = Math.max(0, elapsedMs / 1000);
    const expected = phase.seconds * 2 * outerPassDelayMs() / 1000;
    phaseProgress = Math.min(1, elapsed / expected);
  }

  const totalNominal = phases.reduce((total, item) => total + item.seconds, 0);
  for (const segment of elements.timeline) {
    const item = phaseByKey.get(segment.dataset.phase);
    segment.style.setProperty("--phase-share", `${(item.seconds / totalNominal) * 100}%`);
    const isActive = item.key === activePhaseKey;
    segment.classList.toggle("is-active", isActive);
    const fill = segment.querySelector(".segment-fill");
    fill.style.width = `${completedPhases.has(item.key) ? 100 : (isActive ? phaseProgress * 100 : 0)}%`;
  }
}

function render() {
  updateSignals();
  updateRegisters();
  updateCodeHighlight();
  updateExecutionControls();
  updateTimeline();
}

function armTimer() {
  if (!running || !pendingWork || timerId !== null) return;
  timerDueAt = performance.now() + remainingDelay;
  timerId = window.setTimeout(() => {
    timerId = null;
    remainingDelay = 0;
    const work = pendingWork;
    pendingWork = null;
    if (running && work) work();
  }, remainingDelay);
}

function queueWork(delay, work) {
  pendingWork = work;
  remainingDelay = delay;
  armTimer();
}

function startProgressUpdates() {
  if (progressTimerId === null) progressTimerId = window.setInterval(updateTimeline, 100);
}

function stopProgressUpdates() {
  if (progressTimerId !== null) {
    window.clearInterval(progressTimerId);
    progressTimerId = null;
  }
}

function updatePort() {
  state.port = state.a & 0xFF;
  const phase = phases.find((item) => item.port === state.port);
  if (!phase) return;
  if (activePhaseKey === "red" && phase.key === "green") completedPhases = new Set();
  else if (activePhaseKey) completedPhases.add(activePhaseKey);
  activePhaseKey = phase.key;
  phaseStartedAt = null;
  phaseElapsedMs = 0;
  phaseTimerActive = false;
}

function executeInstruction(manual = false) {
  const instruction = program[state.pcIndex];
  if (!instruction) return;

  state.currentId = instruction.id;
  const nextIndex = state.pcIndex + 1;

  switch (instruction.op) {
    case "setup":
      state.sp = 0x1234;
      state.pcIndex = nextIndex;
      break;
    case "load-port":
      state.a = phaseByKey.get(instruction.phase).port;
      state.pcIndex = nextIndex;
      break;
    case "out":
      updatePort();
      state.pcIndex = nextIndex;
      break;
    case "load-count":
      state.b = phaseByKey.get(instruction.phase).seconds;
      state.pcIndex = nextIndex;
      break;
    case "call":
      callStack.push(nextIndex);
      state.sp = (state.sp - 2) & 0xFFFF;
      state.pcIndex = indexById.get("push-psw");
      phaseStartedAt = performance.now();
      phaseElapsedMs = 0;
      phaseTimerActive = true;
      break;
    case "push-psw":
      savedA = state.a;
      state.sp = (state.sp - 2) & 0xFFFF;
      state.pcIndex = nextIndex;
      break;
    case "push-d":
      savedDE = (state.d << 8) | state.e;
      state.sp = (state.sp - 2) & 0xFFFF;
      state.pcIndex = nextIndex;
      break;
    case "mov-a-b":
      state.a = state.b;
      state.pcIndex = nextIndex;
      break;
    case "add-a":
      state.a = (state.a + state.a) & 0xFF;
      state.pcIndex = nextIndex;
      break;
    case "mov-b-a":
      state.b = state.a;
      state.pcIndex = nextIndex;
      break;
    case "lxi-d":
      state.d = 0xFF;
      state.e = 0xFF;
      state.pcIndex = nextIndex;
      break;
    case "dcx-d": {
      const de = (((state.d << 8) | state.e) - 1) & 0xFFFF;
      state.d = (de >> 8) & 0xFF;
      state.e = de & 0xFF;
      state.pcIndex = nextIndex;
      break;
    }
    case "mov-a-d":
      state.a = state.d;
      state.pcIndex = nextIndex;
      break;
    case "ora-e":
      state.a = (state.a | state.e) & 0xFF;
      state.pcIndex = nextIndex;
      break;
    case "jnz-inner":
      // Collapse the 65,535 inner iterations into one wait at the branch.
      if (!manual && running) {
        render();
        queueWork(outerPassDelayMs(), () => {
          state.d = 0;
          state.e = 0;
          state.pcIndex = nextIndex;
          render();
          queueWork(animationDelay(), () => executeInstruction());
        });
        return;
      }
      state.d = 0;
      state.e = 0;
      state.pcIndex = nextIndex;
      break;
    case "dcr-b":
      state.b = (state.b - 1) & 0xFF;
      state.pcIndex = nextIndex;
      break;
    case "jnz-outer":
      state.pcIndex = state.b !== 0 ? indexById.get("lxi-d") : nextIndex;
      break;
    case "pop-d":
      state.d = (savedDE >> 8) & 0xFF;
      state.e = savedDE & 0xFF;
      state.sp = (state.sp + 2) & 0xFFFF;
      state.pcIndex = nextIndex;
      break;
    case "pop-psw":
      state.a = savedA;
      state.sp = (state.sp + 2) & 0xFFFF;
      state.pcIndex = nextIndex;
      break;
    case "ret":
      state.sp = (state.sp + 2) & 0xFFFF;
      state.pcIndex = callStack.pop() ?? indexById.get("green-load");
      break;
    case "jump-start":
      state.pcIndex = indexById.get("green-load");
      break;
    default:
      throw new Error(`Unhandled instruction operation: ${instruction.op}`);
  }

  render();
  if (!manual && running) queueWork(animationDelay(), () => executeInstruction());
}

function run() {
  if (running) return;
  running = true;
  if (phaseTimerActive && phaseStartedAt === null) {
    phaseStartedAt = performance.now();
  }
  startProgressUpdates();
  if (pendingWork) armTimer();
  else executeInstruction();
  render();
}

function pause() {
  if (!running) return;
  running = false;
  if (phaseStartedAt !== null) {
    phaseElapsedMs += performance.now() - phaseStartedAt;
    phaseStartedAt = null;
  }
  if (timerId !== null) {
    window.clearTimeout(timerId);
    timerId = null;
    remainingDelay = Math.max(0, timerDueAt - performance.now());
  }
  stopProgressUpdates();
  render();
}

function step() {
  if (running) pause();
  if (timerId !== null) {
    window.clearTimeout(timerId);
    timerId = null;
  }
  pendingWork = null;
  remainingDelay = 0;
  executeInstruction(true);
}

function reset() {
  pause();
  if (timerId !== null) window.clearTimeout(timerId);
  timerId = null;
  pendingWork = null;
  remainingDelay = 0;
  phaseStartedAt = null;
  phaseElapsedMs = 0;
  phaseTimerActive = false;
  completedPhases = new Set();
  activePhaseKey = null;
  savedA = 0;
  savedDE = 0;
  callStack = [];
  state = freshState();
  render();
}

function updateSpeedLabel() {
  elements.speedValue.textContent = `${speedFactor()}×`;
}

function calculateTiming() {
  const seconds = Number(elements.secondsInput.value);
  const crystalMHz = Number(elements.frequencyInput.value);
  const validSeconds = Number.isInteger(seconds) && seconds > 0 && seconds <= 255;
  const validFrequency = Number.isFinite(crystalMHz) && crystalMHz > 0 && crystalMHz <= 100;

  if (!validSeconds || !validFrequency) {
    elements.calculatorMessage.textContent = "Enter whole seconds from 1–255 and a crystal frequency above 0 and up to 100 MHz.";
    elements.loopCount.textContent = "—";
    elements.effectiveCount.textContent = "—";
    elements.tStates.textContent = "—";
    elements.actualDelay.innerHTML = "— <small>s</small>";
    elements.clockValue.textContent = validFrequency ? `${(crystalMHz / 2).toFixed(2).replace(/\.?0+$/, "")} MHz` : "—";
    return;
  }

  const loops = seconds * 2;
  const effectiveCount = loops & 0xFF;
  const tStates = effectiveCount * T_STATES_PER_PASS;
  const clockMHz = crystalMHz / 2;
  const actual = tStates / (clockMHz * 1_000_000);
  elements.loopCount.textContent = loops.toLocaleString("en-US");
  elements.effectiveCount.textContent = effectiveCount.toLocaleString("en-US");
  elements.tStates.textContent = tStates.toLocaleString("en-US");
  elements.actualDelay.innerHTML = `${actual.toFixed(2)} <small>s</small>`;
  elements.clockValue.textContent = `${clockMHz.toFixed(2).replace(/\.?0+$/, "")} MHz`;
  elements.calculatorMessage.textContent = seconds > 127
    ? `Overflow: 2X = ${loops}, but 8-bit B retains ${effectiveCount}; the actual delay uses that wrapped count.`
    : "";
}

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  elements.themeToggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#111820" : "#f2f5f8";
}

elements.enterSimulator.addEventListener("click", () => {
  elements.welcomeScreen.hidden = true;
  elements.simulatorApp.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
});

elements.runButton.addEventListener("click", run);
elements.pauseButton.addEventListener("click", pause);
elements.stepButton.addEventListener("click", step);
elements.resetButton.addEventListener("click", reset);
elements.speedSlider.addEventListener("input", updateSpeedLabel);
elements.modeToggle.addEventListener("click", () => {
  fastMode = !fastMode;
  elements.modeToggle.setAttribute("aria-pressed", String(fastMode));
  elements.modeLabel.textContent = fastMode ? "Fast" : "Real time";
});
elements.themeToggle.addEventListener("click", toggleTheme);
elements.secondsInput.addEventListener("input", calculateTiming);
elements.frequencyInput.addEventListener("input", calculateTiming);

state = freshState();
updateSpeedLabel();
calculateTiming();
render();
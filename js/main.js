const STORAGE_KEYS = {
	settings: "wordtrainer:settings",
	stats: (lessonKey, direction) => `wordtrainer:stats:${lessonKey}:${direction}`,
};

// Через скільки карток повертати слово, в якому помилився.
const REQUEUE_GAP = 5;
const ADVANCE_DELAY = 450;

const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");

const shuffle = (array) => {
	const result = array.slice();
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
};

class WordTrainer {
	constructor(root, lessons) {
		this.root = root;
		this.lessons = lessons || {};
		this.lessonKeys = Object.keys(this.lessons);
		if (!this.root || this.lessonKeys.length === 0) return;

		this.speechSupported =
			typeof window !== "undefined" && "speechSynthesis" in window;

		this.dom = {
			lessonSelect: root.querySelector("#lessonSelect"),
			directionToggle: root.querySelector("#directionToggle"),
			orderToggle: root.querySelector("#orderToggle"),
			soundField: root.querySelector("#soundField"),
			soundToggle: root.querySelector("#soundToggle"),
			progressFill: root.querySelector("#progressFill"),
			position: root.querySelector("#position"),
			correctCount: root.querySelector("#correctCount"),
			errorCount: root.querySelector("#errorCount"),
			prompt: root.querySelector("#prompt"),
			speakBtn: root.querySelector("#speakBtn"),
			form: root.querySelector("#answerForm"),
			inputWrap: root.querySelector(".input-wrap"),
			input: root.querySelector("#answer"),
			clearBtn: root.querySelector("#clearBtn"),
			feedback: root.querySelector("#feedback"),
			checkBtn: root.querySelector("#checkBtn"),
			hintBtn: root.querySelector("#hintBtn"),
			skipBtn: root.querySelector("#skipBtn"),
			retryBtn: root.querySelector("#retryBtn"),
			restartBtn: root.querySelector("#restartBtn"),
			mistakesList: root.querySelector("#mistakesList"),
			mistakesEmpty: root.querySelector("#mistakesEmpty"),
		};

		this.state = this.loadSettings();
		this.advanceTimer = null;
		this.awaitingAdvance = false;

		this.setupSpeech();
		this.buildLessonOptions();
		this.bindEvents();
		this.startSession();
	}

	get muted() {
		return this.state.sound === "off";
	}

	loadSettings() {
		const fallback = {
			lessonKey: this.lessonKeys[0],
			direction: "ua-en",
			order: "sequential",
			sound: "on",
		};
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
			if (saved && this.lessons[saved.lessonKey]) {
				return { ...fallback, ...saved };
			}
		} catch (_) {
			/* ignore corrupted settings */
		}
		return fallback;
	}

	saveSettings() {
		localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(this.state));
	}

	loadStats() {
		const key = STORAGE_KEYS.stats(this.state.lessonKey, this.state.direction);
		try {
			return JSON.parse(localStorage.getItem(key)) || {};
		} catch (_) {
			return {};
		}
	}

	saveStats() {
		const key = STORAGE_KEYS.stats(this.state.lessonKey, this.state.direction);
		localStorage.setItem(key, JSON.stringify(this.stats));
	}

	setupSpeech() {
		if (!this.speechSupported) {
			this.dom.soundField.hidden = true;
			this.dom.speakBtn.hidden = true;
			return;
		}
		this.dom.soundField.hidden = false;
	}

	buildLessonOptions() {
		this.dom.lessonSelect.innerHTML = this.lessonKeys
			.map((key) => {
				const count = Object.keys(this.lessons[key].words).length;
				const label = `${this.lessons[key].title} (${count})`;
				const selected = key === this.state.lessonKey ? " selected" : "";
				return `<option value="${key}"${selected}>${label}</option>`;
			})
			.join("");

		this.syncToggle(this.dom.directionToggle, this.state.direction);
		this.syncToggle(this.dom.orderToggle, this.state.order);
		this.syncToggle(this.dom.soundToggle, this.state.sound);
	}

	syncToggle(group, value) {
		group.querySelectorAll("button").forEach((btn) => {
			btn.classList.toggle("is-active", btn.dataset.value === value);
		});
	}

	bindEvents() {
		this.dom.lessonSelect.addEventListener("change", (e) => {
			this.state.lessonKey = e.target.value;
			this.saveSettings();
			this.startSession();
		});

		this.dom.directionToggle.addEventListener("click", (e) =>
			this.onToggleClick(e, "direction", this.dom.directionToggle, true)
		);
		this.dom.orderToggle.addEventListener("click", (e) =>
			this.onToggleClick(e, "order", this.dom.orderToggle, true)
		);
		this.dom.soundToggle.addEventListener("click", (e) =>
			this.onToggleClick(e, "sound", this.dom.soundToggle, false)
		);

		this.dom.form.addEventListener("submit", (e) => {
			e.preventDefault();
			if (this.awaitingAdvance) {
				this.advanceNow();
			} else {
				this.checkAnswer();
			}
		});

		this.dom.input.addEventListener("input", () => {
			this.dom.input.classList.remove("error");
			this.updateClearBtn();
		});

		this.dom.input.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.clearInput();
			}
		});

		this.dom.clearBtn.addEventListener("click", () => this.clearInput());
		this.dom.hintBtn.addEventListener("click", () => this.showHint());
		this.dom.skipBtn.addEventListener("click", () => this.skip());
		this.dom.restartBtn.addEventListener("click", () => this.startSession());
		this.dom.retryBtn.addEventListener("click", () => {
			if (this.retryPairs && this.retryPairs.length) {
				this.startSession(this.retryPairs);
			}
		});
		this.dom.speakBtn.addEventListener("click", () => {
			const item = this.currentItem();
			if (item) this.speak(this.englishOf(item));
		});
	}

	onToggleClick(event, key, group, restart) {
		const btn = event.target.closest("button");
		if (!btn) return;
		this.state[key] = btn.dataset.value;
		this.syncToggle(group, btn.dataset.value);
		this.saveSettings();
		if (restart) this.startSession();
	}

	startSession(customPairs) {
		const isRetry = Array.isArray(customPairs);
		let pairs;
		if (isRetry) {
			pairs = customPairs;
		} else {
			const words = this.lessons[this.state.lessonKey].words;
			pairs = Object.entries(words).map(([ua, en]) =>
				this.state.direction === "ua-en"
					? { question: ua, answer: en }
					: { question: en, answer: ua }
			);
		}

		const ordered = this.state.order === "random" ? shuffle(pairs) : pairs;
		this.queue = ordered.map((p) => ({ ...p, wrong: false }));
		this.total = new Set(this.queue.map((p) => p.question)).size;
		this.index = 0;
		this.correct = 0;
		this.errors = 0;
		this.finished = false;
		this.mastered = new Set();
		this.stats = this.loadStats();
		this.clearAdvanceTimer();

		this.dom.retryBtn.hidden = true;
		this.dom.restartBtn.hidden = true;
		this.dom.checkBtn.disabled = false;
		this.dom.hintBtn.disabled = false;
		this.dom.skipBtn.disabled = false;

		this.renderMistakes();
		this.renderCurrent();
	}

	currentItem() {
		return this.queue[this.index];
	}

	englishOf(item) {
		return this.state.direction === "ua-en" ? item.answer : item.question;
	}

	renderCurrent() {
		this.updateProgress();
		const item = this.currentItem();
		if (!item) return this.finish();

		this.dom.prompt.textContent = item.question;
		this.dom.input.value = "";
		this.dom.input.placeholder = "Введіть переклад…";
		this.dom.input.classList.remove("success", "error");
		this.dom.input.disabled = false;
		this.dom.speakBtn.hidden = !this.speechSupported;
		this.clearFeedback();
		this.updateClearBtn();
		this.dom.input.focus();
	}

	updateProgress() {
		const done = this.mastered.size;
		const percent = this.total ? (done / this.total) * 100 : 0;
		this.dom.progressFill.style.width = `${percent}%`;
		this.dom.position.textContent = `Вивчено ${done} / ${this.total}`;
		this.dom.correctCount.textContent = `✓ ${this.correct}`;
		this.dom.errorCount.textContent = `✗ ${this.errors}`;
	}

	checkAnswer() {
		if (this.finished) return;
		const item = this.currentItem();
		if (!item) return;

		const guess = normalize(this.dom.input.value);
		if (!guess) return;

		const accepted = item.answer.split(/[\/,]/).map((part) => normalize(part));
		if (accepted.includes(guess)) {
			this.onCorrect(item);
		} else {
			this.onWrong(item);
		}
	}

	onCorrect(item) {
		this.correct += 1;
		this.mastered.add(item.question);
		this.dom.input.classList.remove("error");
		this.dom.input.classList.add("success");
		this.showFeedback(`Правильно: ${item.answer}`, "ok");
		this.maybeSpeak(this.englishOf(item));

		if (item.wrong) this.requeue(item);

		this.awaitingAdvance = true;
		this.updateProgress();
		this.advanceTimer = setTimeout(() => this.advanceNow(), ADVANCE_DELAY);
	}

	onWrong(item) {
		this.errors += 1;
		item.wrong = true;
		this.mastered.delete(item.question);

		this.dom.input.classList.add("error", "shake");
		setTimeout(() => this.dom.input.classList.remove("shake"), 300);

		this.showFeedback(`Правильна відповідь: ${item.answer}`, "err");
		this.maybeSpeak(this.englishOf(item));

		this.stats[item.question] = (this.stats[item.question] || 0) + 1;
		this.saveStats();
		this.renderMistakes();
		this.updateProgress();
	}

	requeue(item) {
		const pos = Math.min(this.index + REQUEUE_GAP, this.queue.length);
		this.queue.splice(pos, 0, {
			question: item.question,
			answer: item.answer,
			wrong: false,
		});
	}

	advanceNow() {
		this.clearAdvanceTimer();
		this.awaitingAdvance = false;
		this.index += 1;
		if (this.index >= this.queue.length) {
			this.finish();
		} else {
			this.renderCurrent();
		}
	}

	clearAdvanceTimer() {
		if (this.advanceTimer) {
			clearTimeout(this.advanceTimer);
			this.advanceTimer = null;
		}
	}

	skip() {
		if (this.finished) return;
		if (this.awaitingAdvance) return this.advanceNow();
		this.index += 1;
		if (this.index >= this.queue.length) {
			this.finish();
		} else {
			this.renderCurrent();
		}
	}

	showHint() {
		const item = this.currentItem();
		if (!item || this.awaitingAdvance) return;
		const answer = item.answer;
		const visible = Math.max(1, Math.ceil(answer.length / 3));
		const masked =
			answer.slice(0, visible) +
			"•".repeat(Math.max(0, answer.length - visible));
		this.dom.input.value = "";
		this.dom.input.placeholder = masked;
		this.updateClearBtn();
		this.dom.input.focus();
	}

	clearInput() {
		this.dom.input.value = "";
		this.dom.input.classList.remove("error");
		this.updateClearBtn();
		this.dom.input.focus();
	}

	updateClearBtn() {
		this.dom.clearBtn.hidden = !this.dom.input.value;
	}

	finish() {
		this.finished = true;
		this.clearAdvanceTimer();
		this.awaitingAdvance = false;
		this.updateProgress();

		this.dom.prompt.textContent = "Готово! 🎉";
		this.dom.input.value = "";
		this.dom.input.disabled = true;
		this.dom.checkBtn.disabled = true;
		this.dom.hintBtn.disabled = true;
		this.dom.skipBtn.disabled = true;
		this.dom.clearBtn.hidden = true;
		this.dom.speakBtn.hidden = true;
		this.dom.restartBtn.hidden = false;

		this.retryPairs = this.notMastered();
		if (this.retryPairs.length) {
			this.dom.retryBtn.hidden = false;
			this.dom.retryBtn.textContent = `Повторити складні (${this.retryPairs.length})`;
		}

		this.showFeedback(
			`Вивчено ${this.mastered.size} із ${this.total}. Помилок: ${this.errors}.`,
			this.retryPairs.length ? "err" : "ok"
		);
	}

	notMastered() {
		const seen = new Set();
		const result = [];
		for (const item of this.queue) {
			if (!this.mastered.has(item.question) && !seen.has(item.question)) {
				seen.add(item.question);
				result.push({ question: item.question, answer: item.answer });
			}
		}
		return result;
	}

	renderMistakes() {
		const items = Object.entries(this.stats)
			.filter(([, count]) => count > 0)
			.sort((a, b) => b[1] - a[1]);

		this.dom.mistakesEmpty.hidden = items.length > 0;
		this.dom.mistakesList.innerHTML = items
			.map(
				([word, count]) =>
					`<div class="mistake"><span class="mistake__word">${word}</span><span class="mistake__count">${count}</span></div>`
			)
			.join("");
	}

	maybeSpeak(text) {
		if (!this.muted) this.speak(text);
	}

	speak(text) {
		if (!this.speechSupported || !text) return;
		try {
			window.speechSynthesis.cancel();
			const utterance = new SpeechSynthesisUtterance(text);
			utterance.lang = "en-US";
			utterance.rate = 0.95;
			window.speechSynthesis.speak(utterance);
		} catch (_) {
			/* ignore speech errors */
		}
	}

	showFeedback(text, type) {
		this.dom.feedback.textContent = text;
		this.dom.feedback.className = `feedback feedback--${type} is-visible`;
	}

	clearFeedback() {
		this.dom.feedback.textContent = "";
		this.dom.feedback.className = "feedback";
	}
}

document.addEventListener("DOMContentLoaded", () => {
	const root = document.querySelector(".app");
	new WordTrainer(root, window.LESSONS);
});

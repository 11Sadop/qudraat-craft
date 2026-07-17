// Force unregister service worker and clear caches to fetch latest updates
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
        for(let registration of registrations) {
            registration.unregister();
        }
    });
}
if ('caches' in window) {
    caches.keys().then(function(names) {
        for (let name of names) {
            caches.delete(name);
        }
    });
}

// State Management
let quizzesData = {};
let selectedModelName = null;
let selectedMode = 'book'; // 'book', 'study', or 'exam'
let currentQuestionIndex = 0;
let userAnswers = {}; // { questionIndex: selectedChoice }
let timerInterval = null;
let timerSeconds = 0;
let activeQuestionsList = []; // Clean questions for current quiz (excluding standalone passages)
let passageMappings = []; // Maps active question index to passage text if any

const prefixes = ['أ', 'ب', 'ج', 'د'];

function isPledgeQuestion(q) {
    const title = (q.title || '').toLowerCase();
    if (title.includes('كلمة المرور') || title.includes('كلمة مرور') || title.includes('أقسم') || title.includes('اقسم') || title.includes('حلف') || title.includes('تعهد')) {
        return true;
    }
    if (q.choices && q.choices.some(choice => choice.includes('اقسم') || choice.includes('أقسم') || choice.includes('مشترك في دورة') || choice.includes('كلمة المرور'))) {
        return true;
    }
    return false;
}

// Comprehensive Book State
let bookCurrentPageIndex = 0;
let bookPagesKeys = [];
let lastQuizzesCount = 0;
let lastPDFBookCount = 0;

// Local Storage for progress
let userProgress = {
    completed: {}, // { modelName: scorePct }
    theme: 'dark'
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    loadProgress();
    setupEventHandlers();
    loadQuizzes();
    
    // Live update dashboard every 60 seconds while crawler is running
    setInterval(() => {
        const dashboardActive = document.getElementById('dashboard-screen').classList.contains('active');
        if (dashboardActive) {
            loadQuizzes(true);
        }
    }, 60000);
});

// Load theme from localStorage
function loadTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    userProgress.theme = savedTheme;
    updateThemeIcon(savedTheme);
}

function updateThemeIcon(theme) {
    const themeBtn = document.getElementById('theme-toggle');
    if (theme === 'dark') {
        themeBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
    } else {
        themeBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
    }
}

// Setup progress
function loadProgress() {
    const saved = localStorage.getItem('qudurat_progress');
    if (saved) {
        try {
            userProgress = JSON.parse(saved);
        } catch(e) {}
    }
    userProgress.completed = userProgress.completed || {};
    userProgress.incorrectQuestions = userProgress.incorrectQuestions || [];
    userProgress.totalCorrect = userProgress.totalCorrect || 0;
    userProgress.totalIncorrect = userProgress.totalIncorrect || 0;
    
    updateStatsDashboard();
}

function saveProgress() {
    localStorage.setItem('qudurat_progress', JSON.stringify(userProgress));
}

function updateStatsDashboard() {
    const completedKeys = Object.keys(userProgress.completed || {});
    const completedCount = completedKeys.length;
    
    const completedEl = document.getElementById('stat-completed-models');
    if (completedEl) completedEl.innerText = completedCount;
    
    const avgScoreEl = document.getElementById('stat-avg-score');
    if (avgScoreEl) {
        if (completedCount > 0) {
            let sum = 0;
            completedKeys.forEach(k => {
                const comp = userProgress.completed[k];
                const score = (typeof comp === 'object' && comp !== null) ? comp.score : comp;
                sum += score;
            });
            const avg = Math.round(sum / completedCount);
            avgScoreEl.innerText = `${avg}%`;
        } else {
            avgScoreEl.innerText = '0%';
        }
    }

    // Update correct/incorrect stats derived directly from progress
    let totalCorrectCount = 0;
    completedKeys.forEach(k => {
        const comp = userProgress.completed[k];
        if (typeof comp === 'object' && comp !== null) {
            totalCorrectCount += comp.correct || 0;
        } else {
            const model = quizzesData[k];
            if (model) {
                const totalQ = model.questions.filter(q => (q.type === 2 || q.type === 4) && !isPledgeQuestion(q)).length;
                totalCorrectCount += Math.round((comp / 100) * totalQ);
            }
        }
    });
    
    const correctEl = document.getElementById('stat-total-correct');
    if (correctEl) correctEl.innerText = totalCorrectCount;
    
    // Set incorrect status to the length of the active mistakes bank (updates instantly when deleted)
    const mistakesCount = (userProgress.incorrectQuestions || []).length;
    const incorrectEl = document.getElementById('stat-total-incorrect');
    if (incorrectEl) incorrectEl.innerText = mistakesCount;
    
    // Update mistakes badge
    const mistakesBadge = document.getElementById('stat-mistakes-badge');
    if (mistakesBadge) mistakesBadge.innerText = mistakesCount;
}

// Fetch Quizzes from JSON
async function loadQuizzes(isSilent = false) {
    try {
        const response = await fetch('solved_quizzes.json?v=' + Date.now());
        quizzesData = await response.json();
        
        // Update stats
        const totalModels = Object.keys(quizzesData).length;
        const totalModelsEl = document.getElementById('stat-total-models');
        if (totalModelsEl) totalModelsEl.innerText = totalModels;
        
        const searchVal = document.getElementById('search-bar') ? document.getElementById('search-bar').value : '';
        renderModelsList(quizzesData, searchVal);
        
        const bookSearchVal = document.getElementById('book-search-bar') ? document.getElementById('book-search-bar').value : '';
        renderPDFBook(quizzesData, bookSearchVal);
    } catch (e) {
        console.error("Error loading quizzes:", e);
        document.getElementById('models-list-container').innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--error-color);">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; margin-bottom: 12px;"></i>
                <p>عذراً، فشل تحميل ملف الأسئلة والحلول.</p>
                <button class="btn-secondary" onclick="loadQuizzes()" style="margin-top: 12px;">إعادة المحاولة</button>
            </div>
        `;
    }
}

// Render list of quizzes
function renderModelsList(data, filterText = '') {
    const container = document.getElementById('models-list-container');
    if (!container) return;
    
    const keys = Object.keys(data);
    
    // Re-build DOM only if data size changed or container is empty
    if (keys.length !== lastQuizzesCount || container.children.length <= 1) {
        container.innerHTML = '';
        keys.forEach(key => {
            const model = data[key];
            const modelTitle = model.title || key;
            const totalQuestions = model.questions.filter(q => (q.type === 2 || q.type === 4) && !isPledgeQuestion(q)).length;
            
            const card = document.createElement('div');
            card.className = 'model-card';
            card.id = `model-card-${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
            
            const completedData = userProgress.completed && userProgress.completed[key];
            const isSolved = completedData !== undefined;
            
            let score = 0;
            let correct = 0;
            let incorrect = 0;
            let total = totalQuestions;
            
            if (isSolved) {
                if (typeof completedData === 'object' && completedData !== null) {
                    score = completedData.score;
                    correct = completedData.correct;
                    incorrect = completedData.incorrect;
                    total = completedData.total || totalQuestions;
                } else {
                    score = completedData;
                    correct = Math.round((score / 100) * total);
                    incorrect = total - correct;
                }
            }
            
            const solvedBadge = isSolved ? 
                `<span class="model-badge" style="background: rgba(16,185,129,0.1); color: var(--success-color);">حل سابق: ${score}%</span>` : 
                `<span class="model-badge">جديد</span>`;
                
            let statsRowHTML = '';
            if (isSolved) {
                statsRowHTML = `
                    <div class="model-card-stats" style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); font-size: 13px; font-weight: 700; width: 100%;">
                        <span style="color: var(--success-color); display: flex; align-items: center; gap: 4px;"><i class="fa-solid fa-circle-check"></i> ${correct} صح</span>
                        <span style="color: var(--error-color); display: flex; align-items: center; gap: 4px;"><i class="fa-solid fa-circle-xmark"></i> ${incorrect} خطأ</span>
                        <span style="color: var(--accent-color); background: rgba(139, 92, 246, 0.1); padding: 2px 8px; border-radius: 6px;">${score}%</span>
                    </div>
                `;
            }
                
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:12px; color:var(--text-secondary); font-weight:700;">${key.split(':')[0]}</span>
                    ${solvedBadge}
                </div>
                <h3 class="model-title">${modelTitle}</h3>
                <div class="model-meta">
                    <span><i class="fa-solid fa-circle-question" style="margin-left: 6px;"></i> ${totalQuestions} سؤال</span>
                    <span style="color: var(--accent-color);"><i class="fa-solid fa-play"></i> ابدأ الاختبار</span>
                </div>
                ${statsRowHTML}
            `;
            card.addEventListener('click', () => openModeModal(key));
            container.appendChild(card);
        });
        lastQuizzesCount = keys.length;
    } else {
        // Just update badges in case score changed
        keys.forEach(key => {
            const cleanId = `model-card-${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
            const card = document.getElementById(cleanId);
            if (card) {
                const badgeEl = card.querySelector('.model-badge');
                const completedData = userProgress.completed && userProgress.completed[key];
                const isSolved = completedData !== undefined;
                
                let score = 0;
                let correct = 0;
                let incorrect = 0;
                
                if (isSolved) {
                    if (typeof completedData === 'object' && completedData !== null) {
                        score = completedData.score;
                        correct = completedData.correct;
                        incorrect = completedData.incorrect;
                    } else {
                        score = completedData;
                        const model = data[key];
                        const totalQuestions = model ? model.questions.filter(q => (q.type === 2 || q.type === 4) && !isPledgeQuestion(q)).length : 10;
                        correct = Math.round((score / 100) * totalQuestions);
                        incorrect = totalQuestions - correct;
                    }
                    
                    if (badgeEl) {
                        badgeEl.style.background = 'rgba(16,185,129,0.1)';
                        badgeEl.style.color = 'var(--success-color)';
                        badgeEl.innerText = `حل سابق: ${score}%`;
                    }
                    
                    // Update stats row or add it
                    let statsRow = card.querySelector('.model-card-stats');
                    const newStatsHTML = `
                        <span style="color: var(--success-color); display: flex; align-items: center; gap: 4px;"><i class="fa-solid fa-circle-check"></i> ${correct} صح</span>
                        <span style="color: var(--error-color); display: flex; align-items: center; gap: 4px;"><i class="fa-solid fa-circle-xmark"></i> ${incorrect} خطأ</span>
                        <span style="color: var(--accent-color); background: rgba(139, 92, 246, 0.1); padding: 2px 8px; border-radius: 6px;">${score}%</span>
                    `;
                    
                    if (statsRow) {
                        statsRow.innerHTML = newStatsHTML;
                    } else {
                        statsRow = document.createElement('div');
                        statsRow.className = 'model-card-stats';
                        statsRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); font-size: 13px; font-weight: 700; width: 100%;";
                        statsRow.innerHTML = newStatsHTML;
                        card.appendChild(statsRow);
                    }
                } else {
                    if (badgeEl) {
                        badgeEl.style.background = 'rgba(var(--accent-color-rgb), 0.1)';
                        badgeEl.style.color = 'var(--accent-color)';
                        badgeEl.innerText = 'جديد';
                    }
                    const statsRow = card.querySelector('.model-card-stats');
                    if (statsRow) statsRow.remove();
                }
            }
        });
    }
    
    // Now, filter visibility
    let visibleCount = 0;
    keys.forEach(key => {
        const cleanId = `model-card-${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const card = document.getElementById(cleanId);
        if (card) {
            const model = data[key];
            const modelTitle = model.title || key;
            const matches = !filterText || modelTitle.toLowerCase().includes(filterText.toLowerCase()) || key.toLowerCase().includes(filterText.toLowerCase());
            if (matches) {
                card.style.display = 'block';
                visibleCount++;
            } else {
                card.style.display = 'none';
            }
        }
    });
    
    // Show/hide empty message
    let emptyEl = document.getElementById('models-empty-msg');
    if (visibleCount === 0) {
        if (!emptyEl) {
            emptyEl = document.createElement('div');
            emptyEl.id = 'models-empty-msg';
            emptyEl.style.gridColumn = '1/-1';
            emptyEl.style.textAlign = 'center';
            emptyEl.style.padding = '40px';
            emptyEl.style.color = 'var(--text-secondary)';
            emptyEl.innerHTML = `
                <i class="fa-solid fa-magnifying-glass-minus" style="font-size: 32px; margin-bottom: 12px;"></i>
                <p>لم يتم العثور على أي نموذج يطابق البحث.</p>
            `;
            container.appendChild(emptyEl);
        } else {
            emptyEl.style.display = 'block';
        }
    } else {
        if (emptyEl) emptyEl.style.display = 'none';
    }
}

// Render all models sequentially as a single compiled PDF-style document
let currentPDFFilterText = '';

// Render all models sequentially as a single compiled PDF-style document
function renderPDFBook(data, filterText = '') {
    const container = document.getElementById('pdf-book-container');
    if (!container) return;
    
    currentPDFFilterText = filterText;
    container.innerHTML = '';
    
    const keys = Object.keys(data).sort((a, b) => {
        const aNum = parseInt(a.replace(/[^0-9]/g, '')) || 0;
        const bNum = parseInt(b.replace(/[^0-9]/g, '')) || 0;
        return aNum - bNum;
    });
    
    // Filter matching keys
    const matchingKeys = keys.filter(key => {
        const model = data[key];
        const modelTitle = model.title || key;
        return !filterText || modelTitle.toLowerCase().includes(filterText.toLowerCase()) || key.toLowerCase().includes(filterText.toLowerCase());
    });
    
    // Update jump selector dropdown (do this immediately so all options are listed)
    const jumpSelector = document.getElementById('book-jump-selector');
    if (jumpSelector) {
        jumpSelector.innerHTML = '';
        matchingKeys.forEach(key => {
            const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
            const option = document.createElement('option');
            option.value = cleanKey;
            const numPart = key.split(':')[0].trim();
            const titlePart = data[key].title || key.split(':')[1] || '';
            option.innerText = `${numPart}: ${titlePart}`;
            jumpSelector.appendChild(option);
        });
    }
    
    // Show/hide empty message
    let emptyEl = document.getElementById('pdf-book-empty');
    if (matchingKeys.length === 0) {
        if (!emptyEl) {
            emptyEl = document.createElement('div');
            emptyEl.id = 'pdf-book-empty';
            emptyEl.style.textAlign = 'center';
            emptyEl.style.padding = '40px';
            emptyEl.style.color = 'var(--text-secondary)';
            emptyEl.innerHTML = `
                <i class="fa-solid fa-magnifying-glass-minus" style="font-size: 32px; margin-bottom: 12px;"></i>
                <p>لم يتم العثور على أي نموذج يطابق البحث.</p>
            `;
            container.appendChild(emptyEl);
        } else {
            emptyEl.style.display = 'block';
            container.appendChild(emptyEl);
        }
    } else {
        if (emptyEl) emptyEl.style.display = 'none';
        
        // Initial render: load first 10 pages
        loadMorePDFPages();
    }
}

// Lazy load batch of 10 pages
function loadMorePDFPages() {
    const data = quizzesData;
    const filterText = currentPDFFilterText;
    const container = document.getElementById('pdf-book-container');
    if (!container) return;
    
    const keys = Object.keys(data).sort((a, b) => {
        const aNum = parseInt(a.replace(/[^0-9]/g, '')) || 0;
        const bNum = parseInt(b.replace(/[^0-9]/g, '')) || 0;
        return aNum - bNum;
    });
    
    const matchingKeys = keys.filter(key => {
        const model = data[key];
        const modelTitle = model.title || key;
        return !filterText || modelTitle.toLowerCase().includes(filterText.toLowerCase()) || key.toLowerCase().includes(filterText.toLowerCase());
    });
    
    const currentRenderedCount = container.querySelectorAll('.pdf-page').length;
    if (currentRenderedCount >= matchingKeys.length) return;
    
    const nextBatch = matchingKeys.slice(currentRenderedCount, currentRenderedCount + 10);
    
    nextBatch.forEach((key, idx) => {
        const globalIdx = currentRenderedCount + idx;
        const model = data[key];
        const modelTitle = model.title || key;
        const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
        
        const pageEl = document.createElement('div');
        pageEl.className = 'pdf-page';
        pageEl.id = `pdf-page-${cleanKey}`;
        pageEl.style.transition = 'outline 0.3s ease';
        
        let passageHTML = '';
        const passageQuestions = model.questions.filter(q => q.type === 0);
        if (passageQuestions.length > 0 && passageQuestions[0].title && passageQuestions[0].title.trim().length > 40) {
            passageHTML = `
                <div class="pdf-passage">
                    <strong style="display:block; margin-bottom: 8px;"><i class="fa-solid fa-align-right" style="margin-left: 6px;"></i>نص الاستيعاب والقراءة:</strong>
                    <div dir="auto">${passageQuestions[0].title.replace(/\n/g, '<br>')}</div>
                </div>
            `;
        }
        
        let questionsHTML = '';
        let qCounter = 0;
        const allQ = model.questions.filter(q => !isPledgeQuestion(q));
        let i = 0;
        
        while (i < allQ.length) {
            const q = allQ[i];
            if (q.type === 0 && q.choices.length === 0) {
                const passageText = q.title || '';
                if (passageText.trim().length > 10) {
                    questionsHTML += `
                        <div class="pdf-passage-inline">
                            <div class="pdf-passage-label"><i class="fa-solid fa-paragraph" style="margin-left: 6px;"></i>نص الاستيعاب والقراءة:</div>
                            <div class="pdf-passage-text" dir="auto">${passageText.replace(/\n/g, '<br>')}</div>
                        </div>
                    `;
                }
                i++;
            } else if (q.type === 2 || q.type === 4) {
                qCounter++;
                let optionsHTML = '';
                q.choices.forEach((choice, cIdx) => {
                    const prefix = prefixes[cIdx] || '';
                    const isCorrect = choice === q.correct_answer;
                    const highlightClass = isCorrect ? 'highlighted' : '';
                    const iconHTML = isCorrect ? '<i class="fa-solid fa-check" style="margin-left: 4px; color: #1a1a1a;"></i>' : '';
                    optionsHTML += `
                        <div class="pdf-option ${highlightClass}" dir="auto">
                            <span><strong>${prefix}.</strong> ${choice}</span>
                            ${iconHTML}
                        </div>
                    `;
                });
                
                questionsHTML += `
                    <div class="pdf-question">
                        <div class="pdf-question-title" dir="auto">${qCounter}. ${q.title.replace(/\n/g, '<br>')}</div>
                        <div class="pdf-options-list">
                            ${optionsHTML}
                        </div>
                    </div>
                `;
                i++;
            } else {
                i++;
            }
        }
        
        const pageNum = globalIdx + 1;
        pageEl.innerHTML = `
            <div class="pdf-page-header">
                <span>سبحان الله وبحمده سبحان الله العظيم</span>
                <span>النموذج ${pageNum}</span>
            </div>
            <div class="pdf-page-title">${modelTitle}</div>
            ${passageHTML}
            <div style="display:flex; flex-direction:column; gap:8px;">
                ${questionsHTML}
            </div>
            <div class="pdf-page-footer">
                <span>اللفظي 225 قسم</span>
                <span>صفحة ${pageNum}</span>
            </div>
        `;
        container.appendChild(pageEl);
    });
}

// Force render up to a specific key
function forceRenderUpToKey(targetCleanKey) {
    const data = quizzesData;
    const filterText = currentPDFFilterText;
    const container = document.getElementById('pdf-book-container');
    if (!container) return;
    
    const keys = Object.keys(data).sort((a, b) => {
        const aNum = parseInt(a.replace(/[^0-9]/g, '')) || 0;
        const bNum = parseInt(b.replace(/[^0-9]/g, '')) || 0;
        return aNum - bNum;
    });
    
    const matchingKeys = keys.filter(key => {
        const model = data[key];
        const modelTitle = model.title || key;
        return !filterText || modelTitle.toLowerCase().includes(filterText.toLowerCase()) || key.toLowerCase().includes(filterText.toLowerCase());
    });
    
    const targetIdx = matchingKeys.findIndex(key => key.replace(/[^a-zA-Z0-9]/g, '_') === targetCleanKey);
    if (targetIdx === -1) return;
    
    let currentCount = container.querySelectorAll('.pdf-page').length;
    while (currentCount <= targetIdx) {
        loadMorePDFPages();
        currentCount = container.querySelectorAll('.pdf-page').length;
    }
}

// Scroll listener to load more pages dynamically
window.addEventListener('scroll', () => {
    const tabBook = document.getElementById('tab-book');
    if (tabBook && tabBook.classList.contains('active')) {
        if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 800) {
            loadMorePDFPages();
        }
    }
});

// Event Handlers Setup
function setupEventHandlers() {
    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            userProgress.theme = newTheme;
            updateThemeIcon(newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }
    
    // Search Bar
    const searchBar = document.getElementById('search-bar');
    if (searchBar) {
        searchBar.addEventListener('input', (e) => {
            renderModelsList(quizzesData, e.target.value);
        });
    }
    
    // Search Bar for Book
    const bookSearchBar = document.getElementById('book-search-bar');
    if (bookSearchBar) {
        bookSearchBar.addEventListener('input', (e) => {
            renderPDFBook(quizzesData, e.target.value);
        });
    }
    
    // Modal Mode controls
    const modeModal = document.getElementById('mode-modal');
    const bookBtn = document.getElementById('select-mode-book');
    const studyBtn = document.getElementById('select-mode-study');
    const scrollBtn = document.getElementById('select-mode-scroll');
    const examBtn = document.getElementById('select-mode-exam');
    
    const allModeBtns = [bookBtn, studyBtn, scrollBtn, examBtn].filter(Boolean);
    
    if (bookBtn) {
        bookBtn.addEventListener('click', () => {
            allModeBtns.forEach(b => b.classList.remove('active'));
            bookBtn.classList.add('active');
            selectedMode = 'book';
        });
    }
    
    if (studyBtn) {
        studyBtn.addEventListener('click', () => {
            allModeBtns.forEach(b => b.classList.remove('active'));
            studyBtn.classList.add('active');
            selectedMode = 'study';
        });
    }
    
    if (scrollBtn) {
        scrollBtn.addEventListener('click', () => {
            allModeBtns.forEach(b => b.classList.remove('active'));
            scrollBtn.classList.add('active');
            selectedMode = 'scroll';
        });
    }
    
    if (examBtn) {
        examBtn.addEventListener('click', () => {
            allModeBtns.forEach(b => b.classList.remove('active'));
            examBtn.classList.add('active');
            selectedMode = 'exam';
        });
    }
    
    const modeCancelBtn = document.getElementById('mode-cancel-btn');
    if (modeCancelBtn && modeModal) {
        modeCancelBtn.addEventListener('click', () => {
            modeModal.classList.remove('active');
        });
    }
    
    const modeStartBtn = document.getElementById('mode-start-btn');
    if (modeStartBtn && modeModal) {
        modeStartBtn.addEventListener('click', () => {
            modeModal.classList.remove('active');
            if (selectedMode === 'book') {
                startBookMode();
            } else if (selectedMode === 'scroll') {
                startScrollQuiz();
            } else {
                startQuiz();
            }
        });
    }

    // Scroll quiz back button
    const scrollQuizBackBtn = document.getElementById('scroll-quiz-back-btn');
    if (scrollQuizBackBtn) {
        scrollQuizBackBtn.addEventListener('click', () => {
            if (confirm('هل تريد الخروج؟ لن يتم حفظ إجاباتك.')) {
                switchScreen('dashboard-screen');
            }
        });
    }

    // Scroll quiz submit button
    const scrollSubmitBtn = document.getElementById('scroll-submit-btn');
    if (scrollSubmitBtn) {
        scrollSubmitBtn.addEventListener('click', () => {
            submitScrollQuiz();
        });
    }

    // Tabs switching
    const tabQuizzes = document.getElementById('tab-quizzes');
    const tabBook = document.getElementById('tab-book');
    const tabMistakes = document.getElementById('tab-mistakes');
    
    const quizzesContent = document.getElementById('quizzes-tab-content');
    const bookContent = document.getElementById('book-tab-content');
    const mistakesContent = document.getElementById('mistakes-tab-content');

    function resetTabStyles() {
        [tabQuizzes, tabBook, tabMistakes].forEach(tab => {
            if (tab) {
                tab.classList.remove('active');
                tab.style.background = 'transparent';
                tab.style.color = 'var(--text-secondary)';
            }
        });
        [quizzesContent, bookContent, mistakesContent].forEach(content => {
            if (content) content.style.display = 'none';
        });
    }

    if (tabQuizzes && quizzesContent) {
        tabQuizzes.addEventListener('click', () => {
            resetTabStyles();
            tabQuizzes.classList.add('active');
            tabQuizzes.style.background = 'rgba(139, 92, 246, 0.15)';
            tabQuizzes.style.color = 'var(--accent-color)';
            quizzesContent.style.display = 'flex';
        });
    }

    if (tabBook && bookContent) {
        tabBook.addEventListener('click', () => {
            resetTabStyles();
            tabBook.classList.add('active');
            tabBook.style.background = 'rgba(139, 92, 246, 0.15)';
            tabBook.style.color = 'var(--accent-color)';
            bookContent.style.display = 'flex';
            // Force re-render to always pick up latest data & passage logic
            lastPDFBookCount = 0;
            const bookSearchBar = document.getElementById('book-search-bar');
            const searchVal = bookSearchBar ? bookSearchBar.value : '';
            renderPDFBook(quizzesData, searchVal);
        });
    }

    if (tabMistakes && mistakesContent) {
        tabMistakes.addEventListener('click', () => {
            resetTabStyles();
            tabMistakes.classList.add('active');
            tabMistakes.style.background = 'rgba(139, 92, 246, 0.15)';
            tabMistakes.style.color = 'var(--accent-color)';
            mistakesContent.style.display = 'flex';
            renderMistakes();
        });
    }

    const bookJumpSelector = document.getElementById('book-jump-selector');
    if (bookJumpSelector) {
        bookJumpSelector.addEventListener('change', (e) => {
            const cleanKey = e.target.value;
            const targetId = `pdf-page-${cleanKey}`;
            let element = document.getElementById(targetId);
            if (!element) {
                // Not rendered in DOM yet because of lazy loading - force render up to this key
                forceRenderUpToKey(cleanKey);
                element = document.getElementById(targetId);
            }
            if (element) {
                element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Highlight the page momentarily to draw attention
                element.style.outline = '3px solid var(--accent-color)';
                setTimeout(() => {
                    element.style.outline = 'none';
                }, 1500);
            }
        });
    }
    
    // Quiz navigation
    const quizBackBtn = document.getElementById('quiz-back-btn');
    if (quizBackBtn) {
        quizBackBtn.addEventListener('click', () => {
            if (confirm("هل تريد الخروج من هذا الاختبار؟ لن يتم حفظ إجاباتك الحالية.")) {
                clearInterval(timerInterval);
                switchScreen('dashboard-screen');
            }
        });
    }
    
    document.getElementById('nav-prev-btn').addEventListener('click', () => {
        if (currentQuestionIndex > 0) {
            currentQuestionIndex--;
            renderQuestion();
        }
    });
    
    document.getElementById('nav-next-btn').addEventListener('click', () => {
        const currentQ = activeQuestionsList[currentQuestionIndex];
        // Check if answered
        if (selectedMode === 'exam' || userAnswers[currentQuestionIndex] !== undefined) {
            if (currentQuestionIndex < activeQuestionsList.length - 1) {
                currentQuestionIndex++;
                renderQuestion();
            } else {
                submitQuiz();
            }
        } else {
            alert("يرجى اختيار إجابة أولاً للمتابعة في وضع التدريب.");
        }
    });
    
    // Results actions
    document.getElementById('res-home-btn').addEventListener('click', () => {
        switchScreen('dashboard-screen');
    });
    
    document.getElementById('res-retry-btn').addEventListener('click', () => {
        startQuiz();
    });
    
    // PWA install banner prompt
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        document.getElementById('pwa-install-banner').classList.add('active');
    });
    
    document.getElementById('pwa-install-btn').addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') {
                document.getElementById('pwa-install-banner').classList.remove('active');
            }
            deferredPrompt = null;
        }
    });
}

function switchScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Modal open
function openModeModal(modelKey) {
    selectedModelName = modelKey;
    selectedMode = 'study'; // Default mode
    ['select-mode-study','select-mode-scroll','select-mode-exam'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const studyBtn = document.getElementById('select-mode-study');
    if (studyBtn) studyBtn.classList.add('active');
    const modal = document.getElementById('mode-modal');
    if (modal) modal.classList.add('active');
}

// Quiz processing and execution
function startQuiz() {
    const model = quizzesData[selectedModelName];
    if (!model) return;
    
    // Parse questions: extract only graded MCQ questions
    const rawQuestions = model.questions;
    activeQuestionsList = [];
    passageMappings = [];
    
    let currentPassage = null;
    
    for (let i = 0; i < rawQuestions.length; i++) {
        const q = rawQuestions[i];
        if (q.type === 0) {
            // This is a paragraph/passage text
            if (q.title && q.title.trim().length > 40) { // Text is long enough to be a passage
                currentPassage = q.title;
            }
        } else if ((q.type === 2 || q.type === 4) && !isPledgeQuestion(q)) {
            // Graded question
            activeQuestionsList.push(q);
            // Map the current passage to this question index
            passageMappings.push(currentPassage);
        }
    }
    
    if (activeQuestionsList.length === 0) {
        alert("هذا النموذج لا يحتوي على أسئلة اختيار من متعدد متوافقة حالياً.");
        return;
    }
    
    // Reset state
    currentQuestionIndex = 0;
    userAnswers = {};
    
    // Timer setting (Exam Mode)
    if (selectedMode === 'exam') {
        document.getElementById('quiz-timer-container').style.display = 'flex';
        // 2 minutes per question
        timerSeconds = activeQuestionsList.length * 120; 
        updateTimerDisplay();
        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            timerSeconds--;
            updateTimerDisplay();
            if (timerSeconds <= 0) {
                clearInterval(timerInterval);
                alert("انتهى وقت الاختبار المخصص! سيتم تسليم إجاباتك تلقائياً.");
                submitQuiz();
            }
        }, 1000);
    } else {
        document.getElementById('quiz-timer-container').style.display = 'none';
        clearInterval(timerInterval);
    }
    
    document.getElementById('quiz-title').innerText = model.title || selectedModelName;
    
    switchScreen('quiz-screen');
    renderQuestion();
}

function updateTimerDisplay() {
    const mins = Math.floor(timerSeconds / 60);
    const secs = timerSeconds % 60;
    document.getElementById('quiz-timer-val').innerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Render question
function renderQuestion() {
    const q = activeQuestionsList[currentQuestionIndex];
    const totalQ = activeQuestionsList.length;
    
    // Update progress text & fill bar
    document.getElementById('quiz-progress-text').innerText = `السؤال ${currentQuestionIndex + 1} من ${totalQ}`;
    const pct = Math.round(((currentQuestionIndex) / totalQ) * 100);
    document.getElementById('quiz-progress-fill').style.width = `${pct}%`;
    
    // Set navigation buttons
    document.getElementById('nav-prev-btn').style.visibility = currentQuestionIndex === 0 ? 'hidden' : 'visible';
    
    const nextBtn = document.getElementById('nav-next-btn');
    if (currentQuestionIndex === totalQ - 1) {
        nextBtn.innerHTML = `تسليم الاختبار <i class="fa-solid fa-square-check" style="margin-right: 8px;"></i>`;
        nextBtn.style.background = 'var(--success-gradient)';
    } else {
        nextBtn.innerHTML = `التالي <i class="fa-solid fa-chevron-left" style="margin-right: 8px;"></i>`;
        nextBtn.style.background = 'var(--accent-gradient)';
    }
    
    // Handle split layout for passage
    const passage = passageMappings[currentQuestionIndex];
    const passagePanel = document.getElementById('quiz-passage-panel');
    const layout = document.getElementById('quiz-body-layout');
    
    if (passage) {
        passagePanel.style.display = 'block';
        document.getElementById('quiz-passage-content').innerHTML = passage.replace(/\n/g, '<br>');
        layout.classList.add('has-passage');
    } else {
        passagePanel.style.display = 'none';
        layout.classList.remove('has-passage');
    }
    
    // Render question title
    document.getElementById('quiz-question-text').innerHTML = q.title.replace(/\n/g, '<br>');
    
    // Render options
    const optionsContainer = document.getElementById('quiz-options-container');
    optionsContainer.innerHTML = '';
    
    const selectedAnswer = userAnswers[currentQuestionIndex];
    const isAnswered = selectedAnswer !== undefined;
    
    q.choices.forEach((choice, cIdx) => {
        const prefix = prefixes[cIdx] || '';
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.dataset.choice = choice;
        btn.innerHTML = `
            <span dir="auto"><strong>${prefix}.</strong> ${choice}</span>
            <div class="option-indicator"></div>
        `;
        
        // Handle styling based on state
        if (selectedMode === 'study') {
            if (isAnswered) {
                // Highlight correct/incorrect immediately
                if (choice === q.correct_answer) {
                    btn.classList.add('correct');
                } else if (choice === selectedAnswer) {
                    btn.classList.add('incorrect');
                }
                btn.disabled = true; // Disable clicking after selection
            } else {
                btn.addEventListener('click', () => selectOptionStudy(choice, btn));
            }
        } else {
            // Exam Mode
            if (isAnswered && choice === selectedAnswer) {
                btn.classList.add('selected');
            }
            btn.addEventListener('click', () => selectOptionExam(choice, btn));
        }
        
        optionsContainer.appendChild(btn);
    });
}

// Option selection (Study Mode)
function selectOptionStudy(choice, btnElement) {
    const q = activeQuestionsList[currentQuestionIndex];
    userAnswers[currentQuestionIndex] = choice;
    
    // Render correctness immediately on UI
    document.querySelectorAll('.option-btn').forEach(btn => {
        const optionVal = btn.dataset.choice;
        if (optionVal === q.correct_answer) {
            btn.classList.add('correct');
        } else if (optionVal === choice) {
            btn.classList.add('incorrect');
        }
        btn.disabled = true; // Disable all
    });
}

// Option selection (Exam Mode)
function selectOptionExam(choice, btnElement) {
    userAnswers[currentQuestionIndex] = choice;
    
    // Just toggle selection visual style
    document.querySelectorAll('.option-btn').forEach(btn => {
        btn.classList.remove('selected');
    });
    btnElement.classList.add('selected');
}

// Submit Quiz
function submitQuiz() {
    const totalQ = activeQuestionsList.length;
    const answeredCount = Object.keys(userAnswers).length;
    if (answeredCount < totalQ) {
        const unanswered = totalQ - answeredCount;
        alert(`عذراً، يجب عليك الإجابة على جميع الأسئلة أولاً لتتمكن من تسليم الاختبار. المتبقي: ${unanswered} سؤال.`);
        
        // Jump to the first unanswered question
        for (let i = 0; i < totalQ; i++) {
            if (userAnswers[i] === undefined) {
                currentQuestionIndex = i;
                renderQuestion();
                break;
            }
        }
        return;
    }

    clearInterval(timerInterval);
    
    let correctCount = 0;
    let incorrectCount = 0;
    
    userProgress.incorrectQuestions = userProgress.incorrectQuestions || [];
    userProgress.totalCorrect = userProgress.totalCorrect || 0;
    userProgress.totalIncorrect = userProgress.totalIncorrect || 0;

    activeQuestionsList.forEach((q, idx) => {
        const userAns = userAnswers[idx];
        if (userAns === q.correct_answer) {
            correctCount++;
            userProgress.totalCorrect++;
            userProgress.incorrectQuestions = userProgress.incorrectQuestions.filter(x => x.title !== q.title);
        } else {
            incorrectCount++;
            userProgress.totalIncorrect++;
            const exists = userProgress.incorrectQuestions.some(x => x.title === q.title && x.modelName === selectedModelName);
            if (!exists) {
                userProgress.incorrectQuestions.push({
                    modelName: selectedModelName,
                    title: q.title,
                    choices: q.choices,
                    correct_answer: q.correct_answer,
                    userAnswer: userAns || 'لم يتم الإجابة',
                    userAns: userAns || 'لم يتم الإجابة'
                });
            }
        }
    });
    const scorePct = Math.round((correctCount / totalQ) * 100);
    
    // Save progress in local storage
    if (!userProgress.completed) {
        userProgress.completed = {};
    }
    // Only overwrite if score is higher
    const pastScoreVal = userProgress.completed[selectedModelName];
    const pastScore = (typeof pastScoreVal === 'object' && pastScoreVal !== null) ? pastScoreVal.score : (pastScoreVal || 0);
    if (scorePct > pastScore) {
        userProgress.completed[selectedModelName] = {
            score: scorePct,
            correct: correctCount,
            incorrect: incorrectCount,
            total: totalQ
        };
    }
    saveProgress();
    updateStatsDashboard();
    
    // Set Results UI
    document.getElementById('res-score-pct').innerText = `${scorePct}%`;
    document.getElementById('res-score-fraction').innerText = `${correctCount} من ${totalQ}`;
    document.getElementById('res-stat-correct').innerText = correctCount;
    document.getElementById('res-stat-incorrect').innerText = incorrectCount;
    
    const feedbackText = document.getElementById('res-feedback-text');
    const subFeedback = document.getElementById('res-sub-feedback');
    
    if (scorePct >= 90) {
        feedbackText.innerText = "عمل مذهل وممتاز جداً! 🎉";
        subFeedback.innerText = "لقد أظهرت إتقاناً كبيراً لهذا النموذج. استمر في التدرب لبلوغ الدرجة الكاملة!";
    } else if (scorePct >= 75) {
        feedbackText.innerText = "أداء رائع وجيد جداً! 👍";
        subFeedback.innerText = "لقد تجاوزت الاختبار بنسبة ممتازة. يمكنك إعادة المحاولة لتصحيح أخطائك البسيطة.";
    } else if (scorePct >= 50) {
        feedbackText.innerText = "أداء جيد، ولكن يمكنك تحسينه! 🎯";
        subFeedback.innerText = "لقد حققت نتيجة مقبولة. يُنصح بمراجعة القراءة والأسئلة الخاطئة وإعادة المحاولة.";
    } else {
        feedbackText.innerText = "تحتاج للمزيد من المذاكرة والمحاولة! 📚";
        subFeedback.innerText = "الدرجة منخفضة، لا تستسلم! حاول دراسة الأسئلة في وضع التدريب (Study Mode) لفهم الإجابات بشكل أفضل.";
    }
    
    // Generate reviews list
    const reviewContainer = document.getElementById('results-review-container');
    reviewContainer.innerHTML = '';
    
    activeQuestionsList.forEach((q, idx) => {
        const userAns = userAnswers[idx];
        const isCorrect = userAns === q.correct_answer;
        
        const qCard = document.createElement('div');
        qCard.className = 'book-question-card';
        qCard.style.border = isCorrect ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)';
        
        // Status Badge
        let statusBadge = '';
        if (isCorrect) {
            statusBadge = `<span style="padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; background: rgba(16,185,129,0.1); color: var(--success-color);"><i class="fa-solid fa-circle-check" style="margin-left: 4px;"></i>إجابة صحيحة</span>`;
        } else if (userAns === undefined) {
            statusBadge = `<span style="padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; background: rgba(251,191,36,0.1); color: #fbbf24;"><i class="fa-solid fa-circle-minus" style="margin-left: 4px;"></i>لم يتم الإجابة</span>`;
        } else {
            statusBadge = `<span style="padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; background: rgba(239,68,68,0.1); color: var(--error-color);"><i class="fa-solid fa-circle-xmark" style="margin-left: 4px;"></i>إجابة خاطئة</span>`;
        }
        
        // Options grid
        let optionsHTML = '';
        q.choices.forEach((choice, cIdx) => {
            const prefix = prefixes[cIdx] || '';
            let choiceClass = '';
            let iconHTML = '';
            if (choice === q.correct_answer) {
                choiceClass = 'correct';
                iconHTML = '<i class="fa-solid fa-circle-check"></i>';
            } else if (choice === userAns) {
                choiceClass = 'incorrect';
                iconHTML = '<i class="fa-solid fa-circle-xmark"></i>';
            }
            
            optionsHTML += `
                <div class="book-option-item ${choiceClass}">
                    <span dir="auto"><strong>${prefix}.</strong> ${choice}</span>
                    ${iconHTML}
                </div>
            `;
        });
        
        qCard.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 13px; font-weight: 700; color: var(--text-secondary);">سؤال رقم ${idx + 1}</span>
                ${statusBadge}
            </div>
            <div class="book-question-title" dir="auto">${q.title.replace(/\n/g, '<br>')}</div>
            <div class="book-options-grid">
                ${optionsHTML}
            </div>
        `;
        reviewContainer.appendChild(qCard);
    });
    
    updateStatsDashboard();
    switchScreen('results-screen');
}

function startBookMode() {
    // Visually switch tab to Book
    const tabQuizzes = document.getElementById('tab-quizzes');
    const tabBook = document.getElementById('tab-book');
    const quizzesContent = document.getElementById('quizzes-tab-content');
    const bookContent = document.getElementById('book-tab-content');

    tabBook.classList.add('active');
    tabBook.style.background = 'rgba(139, 92, 246, 0.15)';
    tabBook.style.color = 'var(--accent-color)';
    
    tabQuizzes.classList.remove('active');
    tabQuizzes.style.background = 'transparent';
    tabQuizzes.style.color = 'var(--text-secondary)';

    quizzesContent.style.display = 'none';
    bookContent.style.display = 'flex';
    
    switchScreen('dashboard-screen');
    
    // Smooth scroll to the selected model
    setTimeout(() => {
        const cleanKey = selectedModelName.replace(/[^a-zA-Z0-9]/g, '_');
        const targetId = `pdf-page-${cleanKey}`;
        const element = document.getElementById(targetId);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Highlight the page momentarily to draw attention
            element.style.outline = '3px solid var(--accent-color)';
            setTimeout(() => {
                element.style.outline = 'none';
            }, 1500);
        }
    }, 100);
}

function renderMistakes() {
    const container = document.getElementById('mistakes-list-container');
    if (!container) return;
    container.innerHTML = '';
    
    const list = userProgress.incorrectQuestions || [];
    if (list.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 60px 20px; color: var(--text-secondary); background: var(--bg-secondary); border-radius: 24px; border: 1px solid var(--border-color);">
                <i class="fa-solid fa-circle-check" style="font-size: 48px; margin-bottom: 16px; color: var(--success-color);"></i>
                <h4 style="font-size: 18px; font-weight: 800; color: var(--text-primary); margin-bottom: 8px;">بنك الأخطاء فارغ!</h4>
                <p style="font-size: 14px; font-weight: 600; max-width: 400px; margin: 0 auto;">رائع جداً! لم تقم بتسجيل أي أخطاء حتى الآن، أو قمت بحلها جميعاً بنجاح.</p>
            </div>
        `;
        return;
    }
    
    list.forEach((q, idx) => {
        const qCard = document.createElement('div');
        qCard.className = 'book-question-card';
        qCard.style.border = '1px solid rgba(239, 68, 68, 0.2)';
        
        const modelTitle = quizzesData[q.modelName] ? (quizzesData[q.modelName].title || q.modelName) : q.modelName;
        
        let optionsHTML = '';
        const wrongAnswer = q.userAnswer !== undefined ? q.userAnswer : q.userAns;
        
        q.choices.forEach((choice, cIdx) => {
            const prefix = prefixes[cIdx] || '';
            let choiceClass = '';
            let iconHTML = '';
            if (choice === q.correct_answer) {
                choiceClass = 'correct';
                iconHTML = '<i class="fa-solid fa-circle-check"></i>';
            } else if (choice === wrongAnswer) {
                choiceClass = 'incorrect';
                iconHTML = '<i class="fa-solid fa-circle-xmark"></i>';
            }
            
            optionsHTML += `
                <div class="book-option-item ${choiceClass}">
                    <span dir="auto"><strong>${prefix}.</strong> ${choice}</span>
                    ${iconHTML}
                </div>
            `;
        });
        
        qCard.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                <span style="font-size: 13px; font-weight: 700; color: var(--accent-color);"><i class="fa-solid fa-book" style="margin-left: 6px;"></i>المصدر: ${modelTitle}</span>
                <button style="color: var(--error-color); background: rgba(239, 68, 68, 0.08); padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px; border: 1px solid rgba(239, 68, 68, 0.2); transition: all 0.2s;" onclick="removeMistake(${idx})">
                    <i class="fa-solid fa-trash"></i> إزالة من قائمة الأخطاء
                </button>
            </div>
            <div class="book-question-title" dir="auto">${q.title.replace(/\n/g, '<br>')}</div>
            <div class="book-options-grid">
                ${optionsHTML}
            </div>
        `;
        container.appendChild(qCard);
    });
}

function removeMistake(idx) {
    if (confirm("هل أنت متأكد من إزالة هذا السؤال من قائمة الأخطاء؟")) {
        if (userProgress.incorrectQuestions && userProgress.incorrectQuestions[idx] !== undefined) {
            userProgress.incorrectQuestions.splice(idx, 1);
            saveProgress();
            updateStatsDashboard();
            renderMistakes();
        }
    }
}

window.removeMistake = removeMistake;

// ============================================================
// SCROLL QUIZ MODE — ورقة الاختبار الكاملة
// ============================================================
let scrollAnswers = {}; // { qIndex: choiceText }

function startScrollQuiz() {
    const model = quizzesData[selectedModelName];
    if (!model) return;

    // Build question list (same logic as startQuiz)
    const rawQuestions = model.questions;
    activeQuestionsList = [];
    passageMappings = [];
    let currentPassage = null;

    for (let i = 0; i < rawQuestions.length; i++) {
        const q = rawQuestions[i];
        if (q.type === 0 && q.choices.length === 0) {
            if (q.title && q.title.trim().length > 10) {
                currentPassage = q.title;
            }
        } else if ((q.type === 2 || q.type === 4) && !isPledgeQuestion(q)) {
            activeQuestionsList.push(q);
            passageMappings.push(currentPassage);
            currentPassage = null; // reset after attaching
        }
    }

    if (activeQuestionsList.length === 0) {
        alert('هذا النموذج لا يحتوي على أسئلة.');
        return;
    }

    scrollAnswers = {};
    const total = activeQuestionsList.length;

    // Set header info
    document.getElementById('scroll-quiz-title').innerText = model.title || selectedModelName;
    document.getElementById('scroll-quiz-counter').innerText = `إجمالي الأسئلة: ${total}`;
    document.getElementById('scroll-answered-badge').innerText = `أجبت: 0 / ${total}`;

    // Build questions DOM
    const container = document.getElementById('scroll-questions-container');
    container.innerHTML = '';

    activeQuestionsList.forEach((q, qIdx) => {
        // Passage block if present
        const passage = passageMappings[qIdx];
        if (passage) {
            const passageBlock = document.createElement('div');
            passageBlock.className = 'pdf-passage-inline';
            passageBlock.innerHTML = `
                <div class="pdf-passage-label"><i class="fa-solid fa-paragraph" style="margin-left:6px;"></i>نص الاستيعاب والقراءة:</div>
                <div class="pdf-passage-text" dir="auto">${passage.replace(/\n/g, '<br>')}</div>
            `;
            container.appendChild(passageBlock);
        }

        // Question card
        const card = document.createElement('div');
        card.className = 'question-card';
        card.id = `scroll-q-${qIdx}`;
        card.style.borderRight = '3px solid var(--border-color)';
        card.style.transition = 'border-color 0.3s ease';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'question-text';
        titleDiv.style.fontSize = '16px';
        titleDiv.style.fontWeight = '700';
        titleDiv.style.marginBottom = '16px';
        titleDiv.innerHTML = `<span style="color:var(--accent-color); margin-left:6px;">${qIdx + 1}.</span> ${q.title.replace(/\n/g, '<br>')}`;
        card.appendChild(titleDiv);

        const optionsGrid = document.createElement('div');
        optionsGrid.className = 'options-list';
        optionsGrid.style.flexWrap = 'wrap';

        q.choices.forEach((choice, cIdx) => {
            const prefix = prefixes[cIdx] || '';
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            btn.dataset.choice = choice;
            btn.dataset.qidx = qIdx;
            btn.innerHTML = `<span dir="auto"><strong>${prefix}.</strong> ${choice}</span><div class="option-indicator"></div>`;
            btn.addEventListener('click', () => {
                // Deselect others in this question
                optionsGrid.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                card.style.borderColor = 'var(--accent-color)';
                scrollAnswers[qIdx] = choice;
                
                // Update answered counter
                const answeredCount = Object.keys(scrollAnswers).length;
                document.getElementById('scroll-answered-badge').innerText = `أجبت: ${answeredCount} / ${total}`;
            });
            optionsGrid.appendChild(btn);
        });

        card.appendChild(optionsGrid);
        container.appendChild(card);
    });

    switchScreen('scroll-quiz-screen');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function submitScrollQuiz() {
    const total = activeQuestionsList.length;
    const answeredCount = Object.keys(scrollAnswers).length;

    if (answeredCount < total) {
        const unanswered = total - answeredCount;
        alert(`عذراً، يجب عليك الإجابة على جميع الأسئلة أولاً لتتمكن من تسليم الاختبار. المتبقي: ${unanswered} سؤال.`);
        
        // Find the first unanswered question scroll block and highlight/scroll to it!
        for (let i = 0; i < total; i++) {
            if (scrollAnswers[i] === undefined) {
                const qEl = document.getElementById(`scroll-q-${i}`);
                if (qEl) {
                    qEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    qEl.style.outline = '2px solid var(--error-color)';
                    qEl.style.borderRadius = '20px';
                    setTimeout(() => {
                        qEl.style.outline = 'none';
                    }, 2000);
                }
                break;
            }
        }
        return;
    }

    // Calculate results
    let correctCount = 0;
    const incorrectList = [];

    activeQuestionsList.forEach((q, qIdx) => {
        const chosen = scrollAnswers[qIdx];
        if (chosen === q.correct_answer) {
            correctCount++;
        } else {
            incorrectList.push({ ...q, userAnswer: chosen || null });
        }
    });

    const incorrectCount = total - correctCount;
    const scorePct = Math.round((correctCount / total) * 100);

    // Save progress
    userProgress.completed = userProgress.completed || {};
    userProgress.completed[selectedModelName] = {
        score: scorePct,
        correct: correctCount,
        incorrect: incorrectCount,
        total: total
    };
    userProgress.totalCorrect = (userProgress.totalCorrect || 0) + correctCount;
    userProgress.totalIncorrect = (userProgress.totalIncorrect || 0) + incorrectCount;

    // Log mistakes
    userProgress.incorrectQuestions = userProgress.incorrectQuestions || [];
    incorrectList.forEach(q => {
        const exists = userProgress.incorrectQuestions.some(x => x.title === q.title && x.modelName === selectedModelName);
        if (!exists) {
            userProgress.incorrectQuestions.push({
                ...q,
                modelName: selectedModelName,
                userAnswer: q.userAnswer,
                userAns: q.userAnswer
            });
        }
    });

    saveProgress();
    updateStatsDashboard();

    // Show results screen
    const feedback = scorePct >= 90 ? 'ممتاز! أداء رائع 🎉' :
                     scorePct >= 70 ? 'جيد جداً، استمر! 💪' :
                     scorePct >= 50 ? 'مقبول، تحتاج مزيداً من المراجعة 📖' :
                     'تحتاج مراجعة مكثفة 🔁';

    document.getElementById('res-score-pct').innerText = `${scorePct}%`;
    document.getElementById('res-score-fraction').innerText = `${correctCount} من ${total}`;
    document.getElementById('res-feedback-text').innerText = feedback;
    document.getElementById('res-stat-correct').innerText = correctCount;
    document.getElementById('res-stat-incorrect').innerText = incorrectCount;

    // Review section
    const reviewContainer = document.getElementById('results-review-container');
    reviewContainer.innerHTML = '';
    activeQuestionsList.forEach((q, qIdx) => {
        const chosen = scrollAnswers[qIdx] || null;
        const isCorrect = chosen === q.correct_answer;
        const reviewCard = document.createElement('div');
        reviewCard.style.cssText = `background: var(--bg-secondary); border-radius: 12px; padding: 16px; border: 1px solid ${isCorrect ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}; border-right: 3px solid ${isCorrect ? 'var(--success-color)' : 'var(--error-color)'};`;
        let optionsReview = '';
        q.choices.forEach((choice, cIdx) => {
            const prefix = prefixes[cIdx] || '';
            let bg = 'var(--bg-tertiary)';
            let color = 'var(--text-primary)';
            if (choice === q.correct_answer) { bg = 'rgba(16,185,129,0.15)'; color = 'var(--success-color)'; }
            else if (choice === chosen && !isCorrect) { bg = 'rgba(239,68,68,0.12)'; color = 'var(--error-color)'; }
            optionsReview += `<div style="padding:8px 12px; border-radius:8px; font-size:13px; font-weight:600; background:${bg}; color:${color}; margin-bottom:6px;">${prefix}. ${choice}</div>`;
        });
        reviewCard.innerHTML = `
            <div style="font-weight:700; font-size:15px; margin-bottom:12px; color:${isCorrect ? 'var(--success-color)' : 'var(--error-color)'}">
                <i class="fa-solid ${isCorrect ? 'fa-circle-check' : 'fa-circle-xmark'}" style="margin-left:6px;"></i>${qIdx + 1}. ${q.title.replace(/\n/g, ' ')}
            </div>
            ${optionsReview}
        `;
        reviewContainer.appendChild(reviewCard);
    });

    switchScreen('results-screen');
}

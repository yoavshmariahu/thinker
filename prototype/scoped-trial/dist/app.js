const panels = [...document.querySelectorAll('[data-panel]')]
const steps = [...document.querySelectorAll('[data-step]')]
const stepLabel = document.querySelector('#stepLabel')
const estimate = document.querySelector('#estimate')
const toast = document.querySelector('#toast')
let currentStep = 1
let analysisTimer

const estimates = ['About 8 minutes', 'About 7 minutes', 'About 5 minutes', 'About 2 minutes', 'Trial complete']

function goToStep(next) {
  currentStep = Number(next)
  panels.forEach(panel => panel.classList.toggle('active', Number(panel.dataset.panel) === currentStep))
  steps.forEach(step => {
    const value = Number(step.dataset.step)
    step.classList.toggle('active', value === currentStep)
    step.classList.toggle('complete', value < currentStep)
    const marker = step.querySelector(':scope > span')
    marker.textContent = value < currentStep ? '✓' : String(value).padStart(2, '0')
  })
  stepLabel.textContent = `Step ${currentStep} of 5`
  estimate.textContent = estimates[currentStep - 1]
  if (currentStep === 4) runAnalysis()
}

document.querySelectorAll('[data-next]').forEach(button => {
  button.addEventListener('click', () => goToStep(button.dataset.next))
})

document.querySelectorAll('.area').forEach(area => {
  area.addEventListener('click', () => {
    document.querySelectorAll('.area').forEach(item => {
      const selected = item === area
      item.classList.toggle('selected', selected)
      item.setAttribute('aria-checked', String(selected))
    })
  })
})

function showToast(message) {
  toast.textContent = message
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 1800)
}

document.querySelector('#copyTask').addEventListener('click', async () => {
  const text = document.querySelector('#taskText').textContent
  try { await navigator.clipboard.writeText(text) } catch {}
  showToast('Task copied')
})

function runAnalysis() {
  clearTimeout(analysisTimer)
  const state = document.querySelector('#analysisState')
  const complete = document.querySelector('#analysisComplete')
  const bar = document.querySelector('#progressBar')
  const current = document.querySelector('#analysisCurrent')
  const last = document.querySelector('#analysisLast')
  state.hidden = false
  complete.hidden = true
  bar.style.width = '57%'
  current.className = ''
  current.innerHTML = 'Tracing authentication flows <span class="loader"></span>'
  last.className = ''
  last.innerHTML = 'Preparing the comparison <span>·</span>'

  analysisTimer = setTimeout(() => {
    bar.style.width = '82%'
    current.className = 'done'
    current.innerHTML = 'Authentication flows traced <span>✓</span>'
    last.innerHTML = 'Preparing the comparison <span class="loader"></span>'
  }, 1200)

  analysisTimer = setTimeout(() => {
    bar.style.width = '100%'
    last.className = 'done'
    last.innerHTML = 'Comparison prepared <span>✓</span>'
  }, 2300)

  analysisTimer = setTimeout(() => {
    state.hidden = true
    complete.hidden = false
  }, 2850)
}

document.querySelector('#restartButton').addEventListener('click', () => goToStep(2))
document.querySelector('#evidenceButton').addEventListener('click', () => showToast('Evidence view would open here'))

const panels = [...document.querySelectorAll('[data-panel]')]
const steps = [...document.querySelectorAll('[data-step]')]
const stepLabel = document.querySelector('#stepLabel')
const estimate = document.querySelector('#estimate')
const toast = document.querySelector('#toast')
const backButton = document.querySelector('#backButton')
const cliToggle = document.querySelector('#cliToggle')
const cliPanel = document.querySelector('#cliPanel')
const cliCommand = document.querySelector('#cliCommand')
const repoSelect = document.querySelector('#repo')
let currentStep = 1
let furthestStep = 1
let analysisTimer

const estimates = ['About 8 minutes', 'About 7 minutes', 'About 5 minutes', 'About 2 minutes', 'Trial complete']

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function commandForStep() {
  const repo = repoSelect.value
  const area = document.querySelector('.area.selected')?.dataset.path || 'src/auth'
  const task = document.querySelector('#taskText').textContent.trim()
  return [
    `thinker trial connect --repo ${repo}`,
    `thinker trial scope --repo ${repo} --path ${area}`,
    `thinker trial baseline --repo ${repo} --path ${area} --task ${shellQuote(task)}`,
    `thinker trial analyze --repo ${repo} --path ${area}`,
    `thinker trial report --repo ${repo} --path ${area}`
  ][currentStep - 1]
}

function updateCliCommand() {
  cliCommand.textContent = commandForStep()
}

function goToStep(next) {
  currentStep = Number(next)
  furthestStep = Math.max(furthestStep, currentStep)
  panels.forEach(panel => panel.classList.toggle('active', Number(panel.dataset.panel) === currentStep))
  steps.forEach(step => {
    const value = Number(step.dataset.step)
    step.classList.toggle('active', value === currentStep)
    step.classList.toggle('complete', value < currentStep)
    step.classList.toggle('available', value <= furthestStep)
    step.setAttribute('aria-current', value === currentStep ? 'step' : 'false')
    step.setAttribute('tabindex', value <= furthestStep ? '0' : '-1')
    const marker = step.querySelector(':scope > span')
    marker.textContent = value < currentStep ? '✓' : String(value).padStart(2, '0')
  })
  stepLabel.textContent = `Step ${currentStep} of 5`
  estimate.textContent = estimates[currentStep - 1]
  backButton.hidden = currentStep === 1
  updateCliCommand()
  if (currentStep === 4) runAnalysis()
}

document.querySelectorAll('[data-next]').forEach(button => {
  button.addEventListener('click', () => goToStep(button.dataset.next))
})

backButton.addEventListener('click', () => goToStep(Math.max(1, currentStep - 1)))

cliToggle.addEventListener('click', () => {
  const expanded = cliToggle.getAttribute('aria-expanded') === 'true'
  cliToggle.setAttribute('aria-expanded', String(!expanded))
  cliPanel.hidden = expanded
  cliToggle.lastChild.textContent = expanded ? ' Show CLI' : ' Hide CLI'
})

document.querySelector('#copyCommand').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(cliCommand.textContent) } catch {}
  showToast('Command copied')
})

repoSelect.addEventListener('change', updateCliCommand)

steps.forEach(step => {
  step.setAttribute('role', 'button')
  const openStep = () => {
    const value = Number(step.dataset.step)
    if (value <= furthestStep) goToStep(value)
  }
  step.addEventListener('click', openStep)
  step.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openStep()
    }
  })
})

document.querySelectorAll('.area').forEach(area => {
  area.addEventListener('click', () => {
    document.querySelectorAll('.area').forEach(item => {
      const selected = item === area
      item.classList.toggle('selected', selected)
      item.setAttribute('aria-checked', String(selected))
    })
    updateCliCommand()
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

goToStep(1)

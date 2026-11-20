/** 懒路由冒烟：导航到 /settings 与 /paintings 两个懒 chunk 路由，验证挂载与无错误边界。 */
const port = Number(process.argv[2] || 9333)

const findPageTarget = async () => {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  if (!page) throw new Error('no page target')
  return page
}

const evaluate = (wsUrl, expression) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), 45000)
    ws.addEventListener('open', () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    )
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text))
      else resolve(msg.result?.result?.value)
    })
    ws.addEventListener('error', (e) => reject(new Error('ws error ' + e.message)))
  })

const NAVIGATE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  for (const route of ['/settings', '/paintings', '/notes']) {
    window.history.pushState({}, '', '#' + route);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(2500);
    const text = document.body ? document.body.innerText : '';
    results.push({
      route,
      hash: location.hash,
      mounted: (document.querySelector('#root')?.childElementCount ?? 0) > 0,
      errorBoundary: text.includes('Something went wrong') || text.includes('出错了'),
      textLength: text.length
    });
  }
  return JSON.stringify(results);
})()`

;(async () => {
  const target = await findPageTarget()
  const raw = await evaluate(target.webSocketDebuggerUrl, NAVIGATE)
  const results = JSON.parse(raw)
  let failures = 0
  for (const r of results) {
    const ok = r.mounted && !r.errorBoundary && r.textLength > 50 && r.hash === '#' + r.route
    if (!ok) failures++
    console.log(
      `${ok ? 'OK ' : 'FAIL'} ${r.route} hash=${r.hash} mounted=${r.mounted} errorBoundary=${r.errorBoundary} text=${r.textLength}`
    )
  }
  if (failures > 0) {
    console.error('LAZY ROUTE FAILED: ' + failures)
    process.exit(1)
  }
  console.log('LAZY ROUTES OK')
})().catch((e) => {
  console.error('ERROR: ' + e.message)
  process.exit(1)
})

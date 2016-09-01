const btoa = require('btoa')
const highwire = require('highwire')

const PendingTimeoutError = require('./pending-timeout-error')

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_USER = process.env.GITHUB_USER
const GREENKEEPER_BOT_GITHUB_URL = 'https://github.com/greenkeeperio-bot'
const SQUASH_MERGES = !!process.env.SQUASH_MERGES || false
const DELETE_BRANCHES = !!process.env.DELETE_BRANCHES || false

const MINUTE = 1000 * 60
const HOUR = MINUTE * 60
const DAY = HOUR * 24

const { get, put, post, del } = highwire

const headers = {
  'Authorization': `Basic ${btoa(GITHUB_USER + ':' + GITHUB_TOKEN)}`,
  'Accept': 'application/vnd.github.polaris-preview+json'
}

const mergePR = (prUrl, commit_title, sha) => {
  const mergeData = {
    sha,
    commit_title,
    squash: SQUASH_MERGES
  }

  return put(`${prUrl}/merge`, mergeData, { headers })
    .catch(() => put(`${prUrl}/merge`, mergeData, { headers })) // Survival rule #2: double tap
}

const validatePR = (prUrl, timeout = MINUTE) =>
  get(prUrl, { headers })
    .then((response) => response.body)
    .then((pr) => {

      console.info('validating PR', {
        timeout,
        prUrl,
        mergeable: pr.mergeable,
        mergeable_state: pr.mergeable_state
      })

      if (pr.mergeable_state !== 'clean') {
        if (timeout > DAY) {
          console.log('pending timeout exceeded, rejecting...')
          return Promise.reject(new PendingTimeoutError())
        }

        console.log('retrying statuses for:', prUrl)
        return new Promise((resolve) => setTimeout(() => resolve(), timeout))
          .then(() => validatePR(prUrl, timeout + MINUTE))
      }

      console.log('statuses verified, continuing...')
      return Promise.resolve()
    })

const deleteBranch = (head) => {
  const { repo } = head
  const path = `/repos/${repo.full_name}/git/refs/heads/${head.ref}`
  const url = `https://api.github.com${path}`

  return del(url, { headers })
}

const openedByGreenKeeperBot = (sender) => {
  return sender.html_url === GREENKEEPER_BOT_GITHUB_URL || sender.html_url === 'https://github.com/stipbot' // @TODO temp
}

const buildErrorComment = (message, prNumber) => {
  return {
    body: `greenkeeper-keeper(pr: ${prNumber}): :x: \`${message}\``
  }
}

const commentWithError = (commentsUrl, prNumber, error) => {
  post(`${commentsUrl}`, buildErrorComment(error.message, prNumber), { headers })
}

module.exports.register = (server, options, next) => {
  server.route({
    method: 'POST',
    path: '/payload',
    handler (request, response) {
      response('ok')

      const { action, sender, pull_request, number } = request.payload

      console.log(action, pull_request && pull_request.url, sender.html_url, pull_request && pull_request.user.login)
      console.log('clean merge?', pull_request && pull_request.mergeable_state)

      if ((action === 'opened' && openedByGreenKeeperBot(sender)) || (action === 'synchronize' && openedByGreenKeeperBot(pull_request.user))) {
        request.log(['info', 'PR', 'validating'], pull_request.url)
        validatePR(pull_request.url)
          .then(() => request.log(['info', 'PR', 'validated']))
          .then(() => mergePR(
            pull_request.url,
            pull_request.title,
            pull_request.head.sha
          ))
          .then(response => response.body)
          .then(data => {
            request.log(['info', 'PR', 'merged'], pull_request.url)

            console.log('did it merge?', data)

            return Promise.resolve()
          })
          .then(() => {
            if (DELETE_BRANCHES) {
              return deleteBranch(pull_request.head)
            }

            return Promise.resolve()
          })
          .catch((error) => {
            request.log(['error', 'PR'], error)
            commentWithError(pull_request.comments_url, number, error)
          })
      } else {
        request.log(['PR', 'skipping'])
      }
    }
  })

  next()
}

module.exports.register.attributes = {
  name: 'keeper',
  version: '0.0.2'
}

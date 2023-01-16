import { planService, projectService } from '../services/project.service'
import { hideDidsAndAddLinksToNetwork } from '../services/util-higher'

class PlanController {

  // gets info but not the full claim
  getPlanInfoByExternalId(req, res) {
    planService
      .infoByExternalId(req.params.id)
      .then(result => hideDidsAndAddLinksToNetwork(res.locals.tokenIssuer, result))
      .then(r => {
        if (r) res.json(r);
        else res.status(404).end();
      })
      .catch(err => { console.log(err); res.status(500).json(""+err).end(); })
  }

}
const planController = new PlanController()




class ProjectController {

  // gets info but not the full claim
  getProjectInfoByExternalId(req, res) {
    projectService
      .infoByExternalId(req.params.id)
      .then(result => hideDidsAndAddLinksToNetwork(res.locals.tokenIssuer, result))
      .then(r => {
        if (r) res.json(r);
        else res.status(404).end();
      })
      .catch(err => { console.log(err); res.status(500).json(""+err).end(); })
  }

}
const projectController = new ProjectController()






import * as express from 'express'

const extPlanRouter = express
  .Router()
  .all('*', function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    next();
  })

/**
 * Check if current user can create a claim.
 *
 * @route GET /plan
 * @param {string} id.path.required - the ID of the PlanAcation record to retrieve
 * @returns {Object} plan data if it exists (or 404)
 */
// This comment makes doctrine-file work with babel. See API docs after: npm run compile; npm start
  .get('/:id', planController.getPlanInfoByExternalId)






const extProjectRouter = express
  .Router()
  .all('*', function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    next();
  })

/**
 * Check if current user can create a claim.
 *
 * @route GET /project
 * @param {string} id.path.required - the ID of the Project record to retrieve
 * @returns {Object} project data if it exists (or 404)
 */
// This comment makes doctrine-file work with babel. See API docs after: npm run compile; npm start
  .get('/:id', projectController.getProjectInfoByExternalId)





module.exports = { extPlanRouter, extProjectRouter }

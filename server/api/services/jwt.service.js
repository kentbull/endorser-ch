import l from '../../common/logger'
import base64url from 'base64url'
import util from 'util'
import didJwt from 'did-jwt'
import R from 'ramda'
import db from './endorser.db.service'
import { calcBbox } from './util';
// I wish this was exposed in the did-jwt module!
import VerifierAlgorithm from '../../../node_modules/did-jwt/lib/VerifierAlgorithm'
import { HIDDEN_TEXT } from './util'
import { addCanSee } from './network-cache.service'
// I couldn't figure out how to import this directly from the module.  Sheesh.
const resolveAuthenticator = require('./crypto/JWT').resolveAuthenticator

require("ethr-did-resolver").default() // loads resolver for "did:ethr"

class JwtService {

  async byId(id, requesterDid) {
    l.info(`${this.constructor.name}.byId(${id}, ${requesterDid})`);
    return db.jwtById(id)
  }

  async byQuery(params, requesterDid) {
    l.info(`${this.constructor.name}.byQuery(${util.inspect(params)})`);
    var resultData
    if (params.claimContents) {
      resultData = await db.jwtByContent(params.claimContents)
    } else {
      resultData = await db.jwtByParams(params)
    }
    let result = resultData.map(j => {
      let thisOne = {id:j.id, issuedAt:j.issuedAt, subject:j.subject, claimContext:j.claimContext, claimType:j.claimType, claim:JSON.parse(j.claim)}
      return thisOne
    })
    return result
  }

  jwtDecoded(encoded) {

    // this line is lifted from didJwt.verifyJWT
    const {payload, header, signature, data} = didJwt.decodeJWT(encoded)
    l.trace(payload, `${this.constructor.name} decoded payload`)
    l.trace(header, `${this.constructor.name} decoded header`)
    l.trace(signature, `${this.constructor.name} decoded signature`)
    l.trace(data, `${this.constructor.name} decoded data`)

    return {payload, header, signature, data}
  }

  /**
  create(jwtEncoded) {
    l.info(`${this.constructor.name}.create(ENCODED)`);
    l.trace(jwtEncoded, "ENCODED")

    const {payload, header, signature, data} = this.jwtDecoded(jwtEncoded)
    let claimEncoded = base64url.encode(payload.claim)
    let jwtEntity = db.buildJwtEntity(payload, claimEncoded, jwtEncoded)
    return db.jwtInsert(jwtEntity)
  }
  **/

  /**
     @return object with: {newId:NUMBER, actionClaimRowId:NUMBER}
       ... where newId is -1 if something went wrong
   **/
  async createOneConfirmation(jwtId, issuerDid, origClaim) {

    l.debug(`${this.constructor.name}.createOneConfirmation(${jwtId}, ${issuerDid}, ${util.inspect(origClaim)})`);

    if (origClaim['@context'] === 'http://schema.org'
        && origClaim['@type'] === 'JoinAction') {

      var events = await db.eventsByParams({orgName:origClaim.event.organizer.name, name:origClaim.event.name, startTime:origClaim.event.startTime})
      if (events.length === 0) throw new Error("Attempted to confirm action at an unrecorded event.")

      let actionClaimId = await db.actionClaimIdByDidEventId(origClaim.agent.did, events[0].id)
      if (actionClaimId === null) throw new Error("Attempted to confirm an unrecorded action.")

      let confirmation = await db.confirmationByIssuerAndAction(issuerDid, actionClaimId)
      if (confirmation !== null) throw new Error(`Attemtpted to confirm an action already confirmed in # ${confirmation.id}`)

      let origClaimStr = JSON.stringify(origClaim)

      let result = await db.confirmationInsert(issuerDid, jwtId, actionClaimId, null, origClaimStr)
      l.debug(`${this.constructor.name}.createOneConfirmation # ${result} added for ${actionClaimId}`);
      return {newId:result, actionClaimId}

    } else if (origClaim['@context'] === 'http://endorser.ch'
               && origClaim['@type'] === 'Tenure') {

      let tenureClaimId = await db.tenureClaimIdByPartyAndGeoShape(origClaim.party.did, origClaim.spatialUnit.geo.polygon)
      if (tenureClaimId === null) throw new Error("Attempted to confirm an unrecorded tenure.")

      let confirmation = await db.confirmationByIssuerAndTenure(issuerDid, tenureClaimId)
      if (confirmation !== null) throw new Error(`Attemtpted to confirm a tenure already confirmed in # ${confirmation.id}`)

      let origClaimStr = JSON.stringify(origClaim)

      let result = await db.confirmationInsert(issuerDid, jwtId, null, tenureClaimId, origClaimStr)
      l.debug(`${this.constructor.name}.createOneConfirmation # ${result} added for ${tenureClaimId}`);
      return {newId:result, tenureClaimId}

    } else {
      l.warning("Attempted to confirm unknown claim with @context " + origClaim['@context'] + " and @type " + origClaim['@type'])
      return {}
    }
  }

  /**
     Take a claim being confirmed by an issuer, and create network records from all targeted people to that issuer

     @param actionClaimId is the claim being confirmed
     @param actionClaimAgentDid is the agent of that claim
     @param issuerDid is the issuer confirming it
     @return array of promises for all the insertions into the network table
   **/
  async createNetworkRecords(agentOrPartyDid, issuerDid, actionClaimId, tenureClaimId) {

    let results = []

    // put the issuer in the confirmed claim-agent's network
    l.trace(`Adding network entry from ${agentOrPartyDid} to ${issuerDid}`)
    results.push(addCanSee(agentOrPartyDid, issuerDid))

    if (actionClaimId) {
      // put the issuer in the confirmed claim's confirmed-issuer network
      results.push(db.manyConfirmationsByActionClaim(actionClaimId)
                   .then(confirmations => {
                     let subResults = []
                     for (var confirm of confirmations) {
                       l.trace(`Adding network entry from ${confirm.issuer} to ${issuerDid}`)
                       subResults.push(addCanSee(confirm.issuer, issuerDid))
                     }
                     return Promise.all(subResults)
                   }))
    }
    if (tenureClaimId) {
      // put the issuer in the confirmed claim's confirmed-issuer network
      results.push(db.manyConfirmationsByTenureClaim(tenureClaimId)
                   .then(confirmations => {
                     let subResults = []
                     for (var confirm of confirmations) {
                       l.trace(`Adding network entry from ${confirm.issuer} to ${issuerDid}`)
                       subResults.push(addCanSee(confirm.issuer, issuerDid))
                     }
                     return Promise.all(subResults)
                   }))
    }

    return Promise.all(results)
  }

  async createEmbeddedClaimRecords(jwtId, issuerDid, claim) {

    l.info(`${this.constructor.name}.createEmbeddedClaimRecords(${jwtId}, ${issuerDid}, ...)`);
    l.trace(`${this.constructor.name}.createEmbeddedClaimRecords(..., ${util.inspect(claim)})`);

    if (claim['@context'] === 'http://schema.org'
        && claim['@type'] === 'JoinAction') {

      let agentDid = claim.agent.did
      if (!agentDid) {
        l.error(`${this.constructor.name} JoinAction for ${jwtId} has no agent DID.`)
        throw new Error("Attempted to record a JoinAction claim with no agent DID.")
      }

      var event
      var events = await db.eventsByParams({orgName:claim.event.organizer.name, name:claim.event.name, startTime:claim.event.startTime})
      if (events.length === 0) {
        let eventId = await db.eventInsert(claim.event.organizer.name, claim.event.name, claim.event.startTime)
        event = {id:eventId, orgName:claim.event.organizer.name, name:claim.event.name, startTime:claim.event.startTime}
        l.trace(`${this.constructor.name} New event # ${util.inspect(event)}`)

      } else {
        event = events[0]
        if (events.length > 1) {
          l.warning(`${this.constructor.name} Multiple events exist with orgName ${claim.event.organizer.name} name ${claim.event.name} startTime ${claim.event.startTime}`)
        }

        let actionClaimId = await db.actionClaimIdByDidEventId(agentDid, events[0].id)
        if (actionClaimId) throw new Error("Attempted to record an action claim that already exists with ID " + actionClaimId)

      }

      let attId = await db.actionClaimInsert(issuerDid, agentDid, jwtId, event)
      l.trace(`${this.constructor.name} New action # ${attId}`)

      await this.createNetworkRecords(agentDid, issuerDid, attId, null)

    } else if (claim['@context'] === 'http://endorser.ch'
               && claim['@type'] === 'Tenure') {

      let bbox = calcBbox(claim.spatialUnit.geo.polygon)
      let entity =
          {
            jwtRowId: jwtId,
            issuerDid: issuerDid,
            partyDid: claim.party && claim.party.did,
            polygon: claim.spatialUnit.geo.polygon,
            westLon: bbox.westLon,
            minLat: bbox.minLat,
            eastLon: bbox.eastLon,
            maxLat: bbox.maxLat
          }
      let tenureId = await db.tenureInsert(entity)

      await this.createNetworkRecords(claim.party && claim.party.did, issuerDid, null, tenureId)

    } else if (claim['@context'] === 'http://endorser.ch'
               && claim['@type'] === 'Confirmation') {

      var recordings = []

      { // handle a single claim
        let origClaim = claim['originalClaim']
        if (origClaim) {
          recordings.push(
            this.createOneConfirmation(jwtId, issuerDid, origClaim)
              .then(confirmData => {
                if (confirmData.actionClaimId) {
                  return this.createNetworkRecords(origClaim.agent.did, issuerDid, confirmData.actionClaimId, null)
                } else if (confirmData.tenureClaimId) {
                  return this.createNetworkRecords(origClaim.party.did, issuerDid, null, confirmData.tenureClaimId)
                } else {
                  throw new Error("Failed to create confirmation for JWT " + jwtId)
                }
              })
              .catch(err => {
                l.error(err)
              })
          )

        }
      }

      { // handle multiple claims
        if (claim['originalClaims']) {
          for (var origClaim of claim['originalClaims']) {
            recordings.push(
              this.createOneConfirmation(jwtId, issuerDid, origClaim)
                .then(confirmData => {
                  if (confirmData.actionClaimId) {
                    return this.createNetworkRecords(origClaim.agent.did, issuerDid, confirmData.actionClaimId, null)
                  } else if (confirmData.tenureClaimId) {
                    return this.createNetworkRecords(origClaim.party.did, issuerDid, null, confirmData.tenureClaimId)
                  } else {
                    throw new Error("Failed to create confirmation for JWT " + jwtId)
                  }
                })
                .catch(err => {
                  l.error(err)
                })
            )
          }
        }
      }
      l.debug(`${this.constructor.name} Created ${recordings.length} confirmations.`)

      await Promise.all(recordings)

    } else {
      throw new Error("Attempted to submit unknown claim type with @context " + claim['@context'] + " and @type " + claim['@type'])
    }
  }

  async decodeAndVerifyJwt(jwt) {
    const {payload, header, signature, data} = this.jwtDecoded(jwt)
    // this line is lifted from didJwt.verifyJWT
    const {doc, authenticators, issuer} = await resolveAuthenticator(header.alg, payload.iss, undefined)
    return {payload, header, signature, data, doc, authenticators, issuer}
  }

  async createWithClaimRecord(jwtEncoded) {
    l.info(`${this.constructor.name}.createWithClaimRecord(ENCODED)`);
    l.trace(jwtEncoded, `${this.constructor.name} ENCODED`)

    let {payload, header, signature, data, doc, authenticators, issuer} = await this.decodeAndVerifyJwt(jwtEncoded)
    if (payload.claim) {
      let claimStr = JSON.stringify(payload.claim)
      let claimEncoded = base64url.encode(claimStr)
      let jwtEntity = db.buildJwtEntity(payload, claimStr, claimEncoded, jwtEncoded)
      let jwtId = await db.jwtInsert(jwtEntity)

      l.debug(doc, `${this.constructor.name} resolved doc`)
      l.trace(authenticators, `${this.constructor.name} resolved authenticators`)
      l.trace(issuer, `${this.constructor.name} resolved issuer`)

      let issuerDid = payload.iss

      // this is the same as the doc.publicKey in my example
      //const signer = VerifierAlgorithm(header.alg)(data, signature, authenticators)

      await this.createEmbeddedClaimRecords(jwtId, issuerDid, payload.claim)
        .catch(err => {
          l.warn(err, `Failed to create embedded claim records.`)
        })

      return jwtId

    } else {
      l.warn(`${this.constructor.name} JWT received without a claim.`)
      return -1 // not undefined because the jwt-controller looks at r.id... how does that even work?
    }
  }

}

export default new JwtService();

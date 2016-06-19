"use strict";
const _               = require('underscore');
const co              = require('co');
const Q               = require('q');
const moment          = require('moment');
const inquirer        = require('inquirer');
const rawer           = require('../ucp/rawer');
const hashf           = require('../ucp/hashf');
const constants       = require('../constants');
const base58          = require('../crypto/base58');
const rules           = require('../rules/index');
const signature       = require('../crypto/signature');
const keyring          = require('../crypto/keyring');
const Identity        = require('../entity/identity');
const Certification   = require('../entity/certification');
const Membership      = require('../entity/membership');
const Block           = require('../entity/block');
const Transaction     = require('../entity/transaction');

module.exports = (mainContext, prover) => new BlockGenerator(mainContext, prover);

function BlockGenerator(mainContext, prover) {

  const that = this;
  let conf, dal, pair, selfPubkey, logger;

  this.setConfDAL = (newConf, newDAL, newPair) => {
    dal = newDAL;
    conf = newConf;
    pair = newPair;
    selfPubkey = base58.encode(pair.publicKey);
    logger = require('../logger')(dal.profile);
  };

  this.nextBlock = () => generateNextBlock(new NextBlockGenerator(conf, dal));

  this.nextEmptyBlock = () => co(function *() {
    const current = yield dal.getCurrentBlockOrNull();
    const lastUDBlock = dal.lastUDBlock();
    const exclusions = yield dal.getToBeKickedPubkeys();
    return createBlock(current, {}, {}, {}, [], exclusions, lastUDBlock, []);
  });

  this.manualRoot = () => co(function *() {
    let current = yield dal.getCurrentBlockOrNull();
    if (current) {
      throw 'Cannot generate root block: it already exists.';
    }
    return generateNextBlock(new ManualRootGenerator());
  });

  this.makeNextBlock = (block, sigFunc, trial, manualValues) => co(function *() {
    const unsignedBlock = block || (yield that.nextBlock());
    const sigF = sigFunc || signature.sync(pair);
    const trialLevel = trial || (yield rules.HELPERS.getTrialLevel(selfPubkey, conf, dal));
    return prover.prove(unsignedBlock, sigF, trialLevel, null, (manualValues && manualValues.time) || null);
  });

  /**
   * Generate next block, gathering both updates & newcomers
   */
  const generateNextBlock = (generator) => co(function *() {
    const current = yield dal.getCurrentBlockOrNull();
    const lastUDBlock = yield dal.lastUDBlock();
    const revocations = yield dal.getRevocatingMembers();
    const exclusions = yield dal.getToBeKickedPubkeys();
    const newCertsFromWoT = yield generator.findNewCertsFromWoT(current);
    const newcomersLeavers = yield findNewcomersAndLeavers(current, generator.filterJoiners);
    const transactions = yield findTransactions();
    const joinData = newcomersLeavers[2];
    const leaveData = newcomersLeavers[3];
    const newCertsFromNewcomers = newcomersLeavers[4];
    const certifiersOfNewcomers = _.uniq(_.keys(joinData).reduce((certifiers, newcomer) => {
      return certifiers.concat(_.pluck(joinData[newcomer].certs, 'from'));
    }, []));
    const certifiers = [].concat(certifiersOfNewcomers);
    // Merges updates
    _(newCertsFromWoT).keys().forEach(function(certified){
      newCertsFromWoT[certified] = newCertsFromWoT[certified].filter((cert) => {
        // Must not certify a newcomer, since it would mean multiple certifications at same time from one member
        const isCertifier = certifiers.indexOf(cert.from) != -1;
        if (!isCertifier) {
          certifiers.push(cert.from);
        }
        return !isCertifier;
      });
    });
    _(newCertsFromNewcomers).keys().forEach((certified) => {
      newCertsFromWoT[certified] = (newCertsFromWoT[certified] || []).concat(newCertsFromNewcomers[certified]);
    });
    // Revocations
    // Create the block
    return createBlock(current, joinData, leaveData, newCertsFromWoT, revocations, exclusions, lastUDBlock, transactions);
  });

  const findNewcomersAndLeavers  = (current, filteringFunc) => co(function*() {
    const newcomers = yield findNewcomers(current, filteringFunc);
    const leavers = yield findLeavers(current);

    const cur = newcomers.current;
    const newWoTMembers = newcomers.newWotMembers;
    const finalJoinData = newcomers.finalJoinData;
    const updates = newcomers.updates;

    return [cur, newWoTMembers, finalJoinData, leavers, updates];
  });

  const findTransactions = () => co(function*() {
    const txs = yield dal.getTransactionsPending();
    const transactions = [];
    const passingTxs = [];
    for(const t in txs) {
      const tx = new Transaction(txs[t], conf.currency);
      const extractedTX = tx.getTransaction();
      try {
        yield Q.nbind(rules.HELPERS.checkBunchOfTransactions, rules, passingTxs.concat(extractedTX));
        yield rules.HELPERS.checkSingleTransaction(extractedTX, {medianTime: moment().utc().unix()}, conf, dal);
        transactions.push(tx);
        passingTxs.push(extractedTX);
        logger.info('Transaction added to block');
      } catch (err) {
        logger.error(err);
        yield dal.removeTxByHash(extractedTX.hash);
      }
    }
    return transactions;
  });

  const findLeavers = (current) => co(function*() {
    const leaveData = {};
    const memberships = yield dal.findLeavers();
    const leavers = [];
    memberships.forEach((ms) => leavers.push(ms.issuer));
    for (const m in memberships) {
      const ms = memberships[m];
      const leave = { identity: null, ms: ms, key: null, idHash: '' };
      leave.idHash = (hashf(ms.userid + ms.certts + ms.issuer) + "").toUpperCase();
      let block;
      if (current) {
        block = yield Q.nbind(dal.getBlockOrNull, dal, ms.number);
      }
      else {
        block = {};
      }
      const identity = yield Q.nbind(dal.getIdentityByHashOrNull, dal, leave.idHash);
      if (identity && block && identity.currentMSN < leave.ms.number && identity.member) {
        // MS + matching cert are found
        leave.identity = identity;
        leaveData[identity.pubkey] = leave;
      }
    }
    return leaveData;
  });

  const findNewcomers = (current, filteringFunc) => co(function*() {
    const updates = {};
    const preJoinData = yield getPreJoinData(current);
    const joinData = yield filteringFunc(preJoinData);
    const members = yield Q.nbind(dal.getMembers, dal);
    const wotMembers = _.pluck(members, 'pubkey');
    // Checking step
    const newcomers = _(joinData).keys();
    const nextBlockNumber = current ? current.number + 1 : 0;
    try {
      const realNewcomers = yield iteratedChecking(newcomers, (someNewcomers) => co(function*() {
        const nextBlock = {
          number: nextBlockNumber,
          joiners: someNewcomers,
          identities: _.filter(newcomers.map((pub) => joinData[pub].identity), { wasMember: false }).map((idty) => idty.pubkey)
        };
        const newLinks = yield computeNewLinks(nextBlockNumber, someNewcomers, joinData, updates);
        yield checkWoTConstraints(nextBlock, newLinks, current);
      }));
      const newLinks = yield computeNewLinks(nextBlockNumber, realNewcomers, joinData, updates);
      const newWoT = wotMembers.concat(realNewcomers);
      const finalJoinData = {};
      realNewcomers.forEach((newcomer) => {
        // Only keep membership of selected newcomers
        finalJoinData[newcomer] = joinData[newcomer];
        // Only keep certifications from final members
        const keptCerts = [];
        joinData[newcomer].certs.forEach((cert) => {
          const issuer = cert.from;
          if (~newWoT.indexOf(issuer) && ~newLinks[cert.to].indexOf(issuer)) {
            keptCerts.push(cert);
          }
        });
        joinData[newcomer].certs = keptCerts;
      });
      return {
        current: current,
        newWotMembers: wotMembers.concat(realNewcomers),
        finalJoinData: finalJoinData,
        updates: updates
      }
    } catch(err) {
      logger.error(err);
      throw err;
    }
  });

  const checkWoTConstraints = (block, newLinks, current) => co(function*() {
    if (block.number < 0) {
      throw 'Cannot compute WoT constraint for negative block number';
    }
    let newcomers = block.joiners.map((inlineMS) => inlineMS.split(':')[0]);
    let realNewcomers = block.identities;
    for (let i = 0, len = newcomers.length; i < len; i++) {
      let newcomer = newcomers[i];
      if (block.number > 0) {
        try {
          // Will throw an error if not enough links
          yield mainContext.checkHaveEnoughLinks(newcomer, newLinks);
          // This one does not throw but returns a boolean
          let isOut = yield rules.HELPERS.isOver3Hops(newcomer, newLinks, realNewcomers, current, conf, dal);
          if (isOut) {
            throw 'Key ' + newcomer + ' is not recognized by the WoT for this block';
          }
        } catch (e) {
          logger.debug(e);
          throw e;
        }
      }
    }
  });

  const iteratedChecking = (newcomers, checkWoTForNewcomers) => co(function*() {
    const passingNewcomers = []
    let hadError = false;
    for (const n in newcomers) {
      const newcomer = newcomers[n];
      try {
        yield checkWoTForNewcomers(passingNewcomers.concat(newcomer));
        passingNewcomers.push(newcomer);
      } catch (err) {
        hadError = hadError || err;
      }
    }
    if (hadError) {
      return yield iteratedChecking(passingNewcomers, checkWoTForNewcomers);
    } else {
      return passingNewcomers;
    }
  });

  const getPreJoinData = (current) => co(function*() {
    const preJoinData = {};
    const memberships = yield dal.findNewcomers();
    const joiners = [];
    memberships.forEach((ms) =>joiners.push(ms.issuer));
    for (const m in memberships) {
      try {
        const ms = memberships[m];
        if (ms.block != constants.BLOCK.SPECIAL_BLOCK) {
          let msBasedBlock = yield dal.getBlock(ms.block);
          let age = current.medianTime - msBasedBlock.medianTime;
          if (age > conf.msWindow) {
            throw 'Too old membership';
          }
        }
        const idtyHash = (hashf(ms.userid + ms.certts + ms.issuer) + "").toUpperCase();
        const join = yield that.getSinglePreJoinData(current, idtyHash, joiners);
        join.ms = ms;
        if (!join.identity.revoked && join.identity.currentMSN < parseInt(join.ms.number)) {
          preJoinData[join.identity.pubkey] = join;
        }
      } catch (err) {
        logger.warn(err);
        throw err;
      }
    }
    return preJoinData;
  });

  const computeNewLinks = (forBlock, theNewcomers, joinData, updates) => co(function *() {
    let newCerts = yield that.computeNewCerts(forBlock, theNewcomers, joinData);
    return that.newCertsToLinks(newCerts, updates);
  });

  this.newCertsToLinks = (newCerts, updates) => {
    let newLinks = {};
    _.mapObject(newCerts, function(certs, pubkey) {
      newLinks[pubkey] = _.pluck(certs, 'from');
    });
    _.mapObject(updates, function(certs, pubkey) {
      newLinks[pubkey] = (newLinks[pubkey] || []).concat(_.pluck(certs, 'pubkey'));
    });
    return newLinks;
  };

  this.computeNewCerts = (forBlock, theNewcomers, joinData) => co(function *() {
    const newCerts = {}, certifiers = [];
    const certsByKey = _.mapObject(joinData, function(val){ return val.certs; });
    for (let i = 0, len = theNewcomers.length; i < len; i++) {
      const newcomer = theNewcomers[i];
      // New array of certifiers
      newCerts[newcomer] = newCerts[newcomer] || [];
      // Check wether each certification of the block is from valid newcomer/member
      for (let j = 0, len2 = certsByKey[newcomer].length; j < len2; j++) {
        const cert = certsByKey[newcomer][j];
        const isAlreadyCertifying = certifiers.indexOf(cert.from) !== -1;
        if (!(isAlreadyCertifying && forBlock > 0)) {
          if (~theNewcomers.indexOf(cert.from)) {
            // Newcomer to newcomer => valid link
            newCerts[newcomer].push(cert);
            certifiers.push(cert.from);
          } else {
            let isMember = yield dal.isMember(cert.from);
            // Member to newcomer => valid link
            if (isMember) {
              newCerts[newcomer].push(cert);
              certifiers.push(cert.from);
            }
          }
        }
      }
    }
    return newCerts;
  });

  this.getSinglePreJoinData = (current, idHash, joiners) => co(function *() {
    const identity = yield dal.getIdentityByHashOrNull(idHash);
    let foundCerts = [];
    const blockOfChainability = current ? (yield dal.getChainabilityBlock(current.medianTime, conf.sigPeriod)) : null;
    if (!identity) {
      throw 'Identity with hash \'' + idHash + '\' not found';
    }
    if (!identity.wasMember && identity.buid != constants.BLOCK.SPECIAL_BLOCK) {
      const idtyBasedBlock = yield dal.getBlock(identity.buid);
      const age = current.medianTime - idtyBasedBlock.medianTime;
      if (age > conf.idtyWindow) {
        throw 'Too old identity';
      }
    }
    const idty = new Identity(identity);
    idty.currency = conf.currency;
    const selfCert = idty.rawWithoutSig();
    const verified = keyring.verify(selfCert, idty.sig, idty.pubkey);
    if (!verified) {
      throw constants.ERRORS.IDENTITY_WRONGLY_SIGNED;
    }
    if (!identity.leaving) {
      if (!current) {
        // Look for certifications from initial joiners
        // TODO: check if this is still working
        const certs = yield dal.certsNotLinkedToTarget(idHash);
        foundCerts = _.filter(certs, function(cert){
          return ~joiners.indexOf(cert.from);
        });
      } else {
        // Look for certifications from WoT members
        let certs = yield dal.certsNotLinkedToTarget(idHash);
        const certifiers = [];
        for (let i = 0; i < certs.length; i++) {
          const cert = certs[i];
          try {
            const basedBlock = yield dal.getBlock(cert.block_number);
            if (!basedBlock) {
              throw 'Unknown timestamp block for identity';
            }
            if (current) {
              const age = current.medianTime - basedBlock.medianTime;
              if (age > conf.sigWindow || age > conf.sigValidity) {
                throw 'Too old certification';
              }
            }
            // Already exists a link not replayable yet?
            let exists = yield dal.existsLinkFromOrAfterDate(cert.from, cert.to, current.medianTime - conf.sigValidity);
            if (exists) {
              throw 'It already exists a similar certification written, which is not replayable yet';
            }
            // Already exists a link not chainable yet?
            exists = yield dal.existsNonChainableLink(cert.from, blockOfChainability ? blockOfChainability.number : -1, conf.sigStock);
            if (exists) {
              throw 'It already exists a certification written which is not chainable yet';
            }
            const isMember = yield dal.isMember(cert.from);
            const doubleSignature = ~certifiers.indexOf(cert.from) ? true : false;
            if (isMember && !doubleSignature) {
              var isValid = yield rules.HELPERS.checkCertificationIsValidForBlock(cert, { number: current.number + 1, currency: current.currency }, identity, conf, dal);
              if (isValid) {
                certifiers.push(cert.from);
                foundCerts.push(cert);
              }
            }
          } catch (e) {
            console.error(e.stack);
            // Go on
          }
        }
      }
    }
    return {
      identity: identity,
      key: null,
      idHash: idHash,
      certs: foundCerts
    };
  });

  const createBlock = (current, joinData, leaveData, updates, revocations, exclusions, lastUDBlock, transactions) => {
    // Revocations have an impact on exclusions
    revocations.forEach((idty) => exclusions.push(idty.pubkey));
    // Prevent writing joins/updates for excluded members
    exclusions = _.uniq(exclusions);
    exclusions.forEach((excluded) => {
      delete updates[excluded];
      delete joinData[excluded];
      delete leaveData[excluded];
    });
    _(leaveData).keys().forEach((leaver) => {
      delete updates[leaver];
      delete joinData[leaver];
    });
    const block = new Block();
    block.version = constants.DOCUMENTS_VERSION;
    block.currency = current ? current.currency : conf.currency;
    block.nonce = 0;
    block.number = current ? current.number + 1 : 0;
    block.parameters = block.number > 0 ? '' : [
      conf.c, conf.dt, conf.ud0,
      conf.sigPeriod, conf.sigStock, conf.sigWindow, conf.sigValidity,
      conf.sigQty, conf.idtyWindow, conf.msWindow, conf.xpercent, conf.msValidity,
      conf.stepMax, conf.medianTimeBlocks, conf.avgGenTime, conf.dtDiffEval,
      conf.blocksRot, (conf.percentRot == 1 ? "1.0" : conf.percentRot)
    ].join(':');
    block.previousHash = current ? current.hash : "";
    block.previousIssuer = current ? current.issuer : "";
    if (selfPubkey)
      block.issuer = selfPubkey;
    // Members merkle
    const joiners = _(joinData).keys();
    const previousCount = current ? current.membersCount : 0;
    if (joiners.length == 0 && !current) {
      throw constants.ERRORS.CANNOT_ROOT_BLOCK_NO_MEMBERS;
    }
    // Newcomers
    block.identities = [];
    // Newcomers + back people
    block.joiners = [];
    joiners.forEach((joiner) => {
      const data = joinData[joiner];
      // Identities only for never-have-been members
      if (!data.identity.member && !data.identity.wasMember) {
        block.identities.push(new Identity(data.identity).inline());
      }
      // Join only for non-members
      if (!data.identity.member) {
        block.joiners.push(new Membership(data.ms).inline());
      }
    });
    block.identities = _.sortBy(block.identities, (line) => {
      const sp = line.split(':');
      return sp[2] + sp[3];
    });
    // Renewed
    block.actives = [];
    joiners.forEach((joiner) => {
      const data = joinData[joiner];
      // Join only for non-members
      if (data.identity.member) {
        block.actives.push(new Membership(data.ms).inline());
      }
    });
    // Leavers
    block.leavers = [];
    const leavers = _(leaveData).keys();
    leavers.forEach((leaver) => {
      var data = leaveData[leaver];
      // Join only for non-members
      if (data.identity.member) {
        block.leavers.push(new Membership(data.ms).inline());
      }
    });
    block.revoked = revocations.map((idty) => [idty.pubkey, idty.revocation_sig].join(':'));
    // Kicked people
    block.excluded = exclusions;
    // Final number of members
    block.membersCount = previousCount + block.joiners.length - block.excluded.length;

    //----- Certifications -----

    // Certifications from the WoT, to newcomers
    block.certifications = [];
    joiners.forEach((joiner) => {
      const data = joinData[joiner] || [];
      data.certs.forEach((cert) => block.certifications.push(new Certification(cert).inline()));
    });
    // Certifications from the WoT, to the WoT
    _(updates).keys().forEach((certifiedMember) => {
      var certs = updates[certifiedMember] || [];
      certs.forEach((cert) => block.certifications.push(new Certification(cert).inline()));
    });
    // Transactions
    block.transactions = [];
    transactions.forEach((tx) => block.transactions.push({ raw: tx.compact() }));

    return co(function *() {
      block.powMin = block.number == 0 ? 0 : yield rules.HELPERS.getPoWMin(block.number, conf, dal);
      if (block.number == 0) {
        block.medianTime = moment.utc().unix() - conf.rootoffset;
      }
      else {
        block.medianTime = yield rules.HELPERS.getMedianTime(block.number, conf, dal);
      }
      // Universal Dividend
      let lastUDTime = lastUDBlock && lastUDBlock.UDTime;
      if (!lastUDTime) {
        const rootBlock = yield dal.getBlockOrNull(0);
        lastUDTime = rootBlock && rootBlock.UDTime;
      }
      if (lastUDTime != null) {
        if (current && lastUDTime + conf.dt <= block.medianTime) {
          const M = current.monetaryMass || 0;
          const c = conf.c;
          const N = block.membersCount;
          const previousUD = lastUDBlock ? lastUDBlock.dividend : conf.ud0;
          const previousUB = lastUDBlock ? lastUDBlock.unitbase : constants.FIRST_UNIT_BASE;
          if (N > 0) {
            block.dividend = Math.ceil(Math.max(previousUD, c * M / Math.pow(10,previousUB) / N));
            block.unitbase = previousUB;
            if (block.dividend >= Math.pow(10, constants.NB_DIGITS_UD)) {
              block.dividend = Math.ceil(block.dividend / 10.0);
              block.unitbase++;
            }
          } else {
            // The community has collapsed. RIP.
            block.dividend = 0;
          }
        }
      }
      // InnerHash
      block.time = block.medianTime;
      block.inner_hash = hashf(rawer.getBlockInnerPart(block)).toUpperCase();
      return block;
    });
  }
}

/**
 * Class to implement strategy of automatic selection of incoming data for next block.
 * @constructor
 */
function NextBlockGenerator(conf, dal) {

  const logger = require('../logger')(dal.profile);

  this.findNewCertsFromWoT = (current) => co(function *() {
    const updates = {};
    const updatesToFrom = {};
    const certs = yield dal.certsFindNew();
    // The block above which (above from current means blocks with number < current)
    const blockOfChainability = current ? (yield dal.getChainabilityBlock(current.medianTime, conf.sigPeriod)) : null;
    for (var i = 0; i < certs.length; i++) {
      const cert = certs[i];
      let exists = false;
      if (current) {
        // Already exists a link not replayable yet?
        exists = yield dal.existsLinkFromOrAfterDate(cert.from, cert.to, current.medianTime - conf.sigValidity);
      }
      if (!exists) {
        // Already exists a link not chainable yet?
        // No chainability block means absolutely nobody can issue certifications yet
        exists = current && (yield dal.existsNonChainableLink(cert.from, blockOfChainability ? blockOfChainability.number : -1, conf.sigStock));
        if (!exists) {
          // It does NOT already exists a similar certification written, which is not replayable yet
          // Signatory must be a member
          const isSignatoryAMember = yield dal.isMember(cert.from);
          const isCertifiedANonLeavingMember = isSignatoryAMember && (yield dal.isMemberAndNonLeaver(cert.to));
          // Certified must be a member and non-leaver
          if (isSignatoryAMember && isCertifiedANonLeavingMember) {
            updatesToFrom[cert.to] = updatesToFrom[cert.to] || [];
            updates[cert.to] = updates[cert.to] || [];
            if (updatesToFrom[cert.to].indexOf(cert.from) == -1) {
              updates[cert.to].push(cert);
              updatesToFrom[cert.to].push(cert.from);
            }
          }
        }
      }
    }
    return updates;
  });

  this.filterJoiners = (preJoinData) => co(function*() {
    const filtered = {};
    const filterings = [];
    const filter = (pubkey) => co(function*() {
      try {
        // No manual filtering, takes all BUT already used UID or pubkey
        let exists = yield rules.HELPERS.checkExistsUserID(preJoinData[pubkey].identity.uid, dal);
        if (exists && !preJoinData[pubkey].identity.wasMember) {
          throw 'UID already taken';
        }
        exists = yield rules.HELPERS.checkExistsPubkey(pubkey, dal);
        if (exists && !preJoinData[pubkey].identity.wasMember) {
          throw 'Pubkey already taken';
        }
        filtered[pubkey] = preJoinData[pubkey];
      }
      catch (err) {
        logger.warn(err);
      }
    });
    _.keys(preJoinData).forEach( (joinPubkey) => filterings.push(filter(joinPubkey)));
    yield filterings;
    return filtered;
  });
}

/**
 * Class to implement strategy of manual selection of root members for root block.
 * @constructor
 */
function ManualRootGenerator() {

  this.findNewCertsFromWoT = () => Q({});

  this.filterJoiners = (preJoinData) => co(function*() {
    const joinData = {};
    const newcomers = _(preJoinData).keys();
    const uids = [];
    newcomers.forEach((newcomer) => uids.push(preJoinData[newcomer].ms.userid));
    if (newcomers.length > 0) {
      inquirer.prompt([{
        type: "checkbox",
        name: "uids",
        message: "Newcomers to add",
        choices: uids,
        default: uids[0]
      }], (answers) => {
        newcomers.forEach((newcomer) => {
          if (~answers.uids.indexOf(preJoinData[newcomer].ms.userid))
            joinData[newcomer] = preJoinData[newcomer];
        });
        if (answers.uids.length == 0)
          throw 'No newcomer selected';
        else
          return joinData;
      });
    } else {
      throw 'No newcomer found';
    }
  });
}

/* eslint no-param-reassign: ["error", { "props": false }] */
/* eslint-disable no-underscore-dangle */

'use strict';

const BaseModel = require('./base');
const parser = require('screwdriver-config-parser');
const workflowParser = require('screwdriver-workflow-parser');
const hoek = require('hoek');
const winston = require('winston');
const _ = require('lodash');
const { PR_JOB_NAME, EXTERNAL_TRIGGER } = require('screwdriver-data-schema').config.regex;
const REGEX_CAPTURING_GROUP = {
    pr: 1, // PR-1
    job: 2 // main or undefined if using legacy
};

winston.level = process.env.LOG_LEVEL || 'info';

/**
 * Sync external triggers
 * Remove the trigger if the job is no longer in yaml, or if the src is no longer in 'requires'
 * Add the trigger src is in 'requires' and was not in the database yet
 * @method syncExternalTriggers
 * @param  {Object}     config              config
 * @param  {Number}     config.pipelineId   pipelineId belongs to this job
 * @param  {String}     config.jobName      name of the job
 * @param  {Array}      config.requiresList requires value of this job
 * @return {Promise}
 */
function syncExternalTriggers(config) {
    // Lazy load factory dependency to prevent circular dependency issues
    // https://nodejs.org/api/modules.html#modules_cycles
    /* eslint-disable global-require */
    const TriggerFactory = require('./triggerFactory');
    /* eslint-enable global-require */

    const triggerFactory = TriggerFactory.getInstance();
    const newSrcList = config.requiresList;
    const dest = `~sd@${config.pipelineId}:${config.jobName}`;
    const processed = [];

    // list records that would trigger this job
    return triggerFactory.list({ params: { dest } })
        .then((records) => {
            // if the src is not in the new src list, then remove it
            const toRemove = records.filter(rec => !newSrcList.includes(rec.src));

            // if the src is not in the old src list, then create in datastore
            const oldSrcList = records.map(r => r.src); // get the old src list
            const toCreate = newSrcList.filter(src =>
                !oldSrcList.includes(src) && EXTERNAL_TRIGGER.test(src));

            toRemove.forEach(rec => processed.push(rec.remove()));
            toCreate.forEach(src => processed.push(triggerFactory.create({ src, dest })));

            return Promise.all(processed);
        });
}

class PipelineModel extends BaseModel {
    /**
     * Construct a PipelineModel object
     * @method constructor
     * @param  {Object}   config                Config object to create the pipeline with
     * @param  {Object}   config.datastore      Object that will perform operations on the datastore
     * @param  {Object}   config.admins         The admins of this repository
     * @param  {String}   config.scmUri         The scmUri for the application
     * @param  {String}   config.scmContext     The scm context to which user belongs
     * @param  {String}   config.createTime     The time the pipeline was created
     */
    constructor(config) {
        super('pipeline', config);
        this.scmContext = config.scmContext;
    }

    /**
     * Get a pipeline factory instance
     * @method _getPipelineFactory
     * @return {Object}         PipelineFactory instance
     */
    _getPipelineFactory() {
        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        // eslint-disable-next-line global-require
        const PipelineFactory = require('./pipelineFactory');

        return PipelineFactory.getInstance();
    }

    /**
     * Get the screwdriver configuration for the pipeline at the given ref
     * @method getConfiguration
     * @param  {Object}  [configuration]       Config object
     * @param  {String}  [configuration.ref]   Reference to get screwdriver.yaml, e.g.sha, prRef, branch
     * @param  {String}  [configuration.isPR]  Flag to indicate if it is getting config for PR
     * @return {Promise}         Resolves to parsed and flattened configuration
     */
    getConfiguration(configuration) {
        const ref = hoek.reach(configuration, 'ref');
        const isPR = hoek.reach(configuration, 'isPR') || false;
        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        // eslint-disable-next-line global-require
        const TemplateFactory = require('./templateFactory');
        const templateFactory = TemplateFactory.getInstance();
        const pipelineFactory = this._getPipelineFactory();

        // If it is a child pipeline, use config pipeline's getConfiguration
        if (this.configPipelineId) {
            return pipelineFactory.get(this.configPipelineId)
                .then((configPipeline) => {
                    // If it is a PR on child pipeline, use config from config pipeline
                    if (isPR) {
                        return configPipeline.getConfiguration({});
                    }

                    return configPipeline.getConfiguration({ ref });
                });
        }

        return this.admin.then(user => user.unsealToken())
            // fetch the screwdriver.yaml file
            .then((token) => {
                const config = {
                    scmUri: this.scmUri,
                    scmContext: this.scmContext,
                    path: 'screwdriver.yaml',
                    token,
                    scmRepo: this.scmRepo
                };

                if (ref) {
                    config.ref = ref;
                }

                return this.scm.getFile(config)
                    .catch(() => '');
            })
            // parse the content of the yaml file
            .then(config => parser(config, templateFactory));
    }

    /**
     * Get part of a PR job name based on given type
     * @method _getPartialJobName
     * @param  {String}    jobName      Name of a PR job
     * @param  {String}    type         Type can either be pr or job, e.g. pr => PR-1, job => main
     * @return {String}                 Substring of a PR job name based on given type
     */
    _getPartialJobName(jobName, type) {
        return jobName.match(PR_JOB_NAME)[REGEX_CAPTURING_GROUP[type]];
    }

    /**
     * Get a list of PR jobs to create or update
     * @method _checkPRState
     * @param  {Array}    existingJobs      List pipeline's existing jobs
     * @param  {Array}    openedPRs         List of opened PRs coming from SCM
     * @return {Promise}                    Resolves to the list of jobs to archive, unarchive and create
     * Note: toArchive and toUnarchive is an array of job objects; toCreate is an array of objects with name and ref.
     */
    _checkPRState(existingJobs, openedPRs) {
        const jobList = {
            toCreate: [],
            toArchive: [],
            toUnarchive: []
        };
        const existingPRs = existingJobs.filter(j => j.isPR()); // list of PRs according to SD
        const openedPRsNames = openedPRs.map(j => j.name);
        const openedPRsRef = openedPRs.map(j => j.ref);

        existingPRs.forEach((job) => {
            // getting PR and number e.g. PR-1
            const prName = this._getPartialJobName(job.name, 'pr');

            // if PR is closed, add it to archive list
            if (!openedPRsNames.includes(prName) && !job.archived) {
                jobList.toArchive.push(job);
            }
        });

        openedPRsNames.forEach((name, i) => {
            const matchedPRs = existingPRs.filter(job => job.name.startsWith(name));

            // if opened PR was previously archived, unarchive it
            matchedPRs.forEach((job) => {
                if (job.archived) {
                    jobList.toUnarchive.push(job);
                }
            });

            // if opened PR is not in the list of existingPRs, create it
            if (matchedPRs.length === 0) {
                jobList.toCreate.push({ name, ref: openedPRsRef[i] });
            }
        });

        return jobList;
    }

    /**
      * Go through the job list to archive/unarchive it and update job config if parsedConfig passed in
      * @method _updateJobArchive
      * @param  {Array}        jobList              List of job objects
      * @param  {boolean}      archived             Archived value to update to
      * @param  {Object}       [parsedConfig]       Parsed job configuration
      * @return {Promise}
      */
    _updateJobArchive(jobList, archived, parsedConfig) {
        const jobsToUpdate = [];

        jobList.forEach((j) => {
            const jobName = this._getPartialJobName(j.name, 'job') || 'main';

            if (parsedConfig) {
                j.permutations = parsedConfig.jobs[jobName];
            }
            j.archived = archived;
            jobsToUpdate.push(j.update());
        });

        return Promise.all(jobsToUpdate);
    }

    /**
     * Go through the list of pr names and create pr jobs
     * @method _createPRJob
     * @param  {Array}      prList       Array of PR names and refs
     * @return {Promise}
     */
    _createPRJob(prList) {
        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        /* eslint-disable global-require */
        const JobFactory = require('./jobFactory');
        /* eslint-enable global-require */

        const factory = JobFactory.getInstance();

        const jobsToCreate = prList.map(pr =>
            this.getConfiguration({
                ref: pr.ref,
                isPR: true
            }).then((config) => {
                const prJobNames = workflowParser.getNextJobs(config.workflowGraph, {
                    trigger: '~pr',
                    prNum: pr.name.split('-')[1]
                });

                return Promise.all[prJobNames.map((name) => {
                    const jobName = this._getPartialJobName(name, 'job');

                    const jobConfig = {
                        pipelineId: this.id,
                        name,
                        permutations: config.jobs[jobName]
                    };

                    return factory.create(jobConfig);
                })];
            }));

        return Promise.all(jobsToCreate);
    }

    /**
     * Attach Screwdriver webhook to the pipeline's repository
     * @param   {String}    webhookUrl    The webhook to be added
     * @method  addWebhook
     * @return  {Promise}
     */
    addWebhook(webhookUrl) {
        return this.token.then(token =>
            this.scm.addWebhook({
                scmUri: this.scmUri,
                scmContext: this.scmContext,
                token,
                webhookUrl
            })
        );
    }

    /**
     * Sync the pull requests by checking against SCM
     * Create or update PR jobs if necessary
     * @method syncPRs
     * @return {Promise}
     */
    syncPRs() {
        return this.token.then(token =>
            Promise.all([
                this.jobs,
                this.scm.getOpenedPRs({
                    scmUri: this.scmUri,
                    scmContext: this.scmContext,
                    token
                })
            ]).then(([existingJobs, openedPRs]) => {
                const jobList = this._checkPRState(existingJobs, openedPRs);

                return Promise.all([
                    this._createPRJob(jobList.toCreate),
                    this._updateJobArchive(jobList.toArchive, true),
                    this._updateJobArchive(jobList.toUnarchive, false)
                ]);
            }));
    }

    /**
     * Sync PR by looking up the PR's screwdriver.yaml
     * Update the permutations to be correct
     * Create missing PR jobs
     * @param   {Number}   prNum        PR Number
     * @method syncPR
     * @return {Promise}
     */
    syncPR(prNum) {
        return this.admin
            .then(user => user.unsealToken())
            .then(token => this.scm.getPrInfo({
                scmUri: this.scmUri,
                scmContext: this.scmContext,
                token,
                prNum,
                scmRepo: this.scmRepo
            }))
            .then(prInfo => Promise.all([
                this.getConfiguration({
                    ref: prInfo.ref,
                    isPR: true
                }),
                this.jobs
            ]))
            .then(([parsedConfig, jobs]) => {
                const prJobs = jobs.filter(j => j.name.startsWith(`PR-${prNum}`));

                // Get next jobs for when startFrom is ~pr
                const nextJobs = workflowParser.getNextJobs(parsedConfig.workflowGraph, {
                    trigger: '~pr',
                    prNum
                });

                // Get all the missing PR- job names
                const existingPRJobNames = prJobs.map(p => p.name);
                const missingPRJobNames = nextJobs.filter(j => !existingPRJobNames.includes(j));

                // Get the job name part, e.g. main from PR-1:main to create job
                const jobsToCreate = missingPRJobNames.map(name => name.split(':')[1]);
                const jobsToArchive = prJobs.filter(p => !nextJobs.includes(p.name));
                const jobsToUnarchive = prJobs.filter(p => nextJobs.includes(p.name));

                // Lazy load factory dependency to prevent circular dependency issues
                // https://nodejs.org/api/modules.html#modules_cycles
                /* eslint-disable global-require */
                const JobFactory = require('./jobFactory');
                /* eslint-enable global-require */
                const jobFactory = JobFactory.getInstance();

                // Create missing PR jobs
                return Promise.all(jobsToCreate.map(jobName =>
                    // Create jobs
                    jobFactory.create({
                        permutations: parsedConfig.jobs[jobName],
                        pipelineId: this.id,
                        name: `PR-${prNum}:${jobName}`
                    })))
                    .then(() => Promise.all([
                        this._updateJobArchive(jobsToArchive, true),
                        this._updateJobArchive(jobsToUnarchive, false, parsedConfig)
                    ]));
            })
            .then(() => delete this.jobs) // so that next time it will not get the cached version of this.jobs
            .then(() => this);
    }

    /**
     * Checks if any admin from this.admins has github permission to given scmUri
     * @method _hasAdminPermission
     * @param  {String}    scmUri
     * @return {Promise}
     */
    async _hasAdminPermission(scmUri) {
        /* eslint-disable no-restricted-syntax */
        for (const username of Object.keys(this.admins)) {
            // eslint-disable-next-line global-require
            const UserFactory = require('./userFactory');
            const factory = UserFactory.getInstance();

            // eslint-disable-next-line no-await-in-loop
            const user = await factory.get({
                username,
                scmContext: this.scmContext
            });

            // eslint-disable-next-line no-await-in-loop
            const permission = await user.getPermissions(scmUri);

            if (permission.admin) {
                return true;
            }
        }
        /* eslint-enable no-restricted-syntax */

        return false;
    }

    /**
     * Get a pipeline given a scmUrl
     * @method _getScmUri
     * @param {String} scmUrl  checkout url for a repository
     * @return {Promise}
     */
    async _getScmUri(scmUrl) {
        const pipelineFactory = this._getPipelineFactory();
        const token = await this.token;
        const admin = await this.admin;
        const scmContext = admin.scmContext;
        const scmUri = await pipelineFactory.scm.parseUrl({
            scmContext,
            checkoutUrl: scmUrl,
            token
        });

        return scmUri;
    }

    /**
     * Update or create a pipeline given a scmUrl
     * @method _createOrUpdatePipeline
     * @param {String} scmUrl  checkout url for a repository
     * @return {Promise}
     */
    async _createOrUpdatePipeline(scmUrl) {
        const pipelineFactory = this._getPipelineFactory();
        const admins = this.admins;
        const scmContext = this.scmContext;
        const scmUri = await this._getScmUri(scmUrl);
        const hasAdminPermission = await this._hasAdminPermission(scmUri);

        if (!hasAdminPermission) {
            // need to figure out how to bubble up this err to user
            winston.error(`No admins of pipeline:${this.id} have admin permissions on ${scmUrl}`);

            return null;
        }

        const pipeline = await pipelineFactory.get({ scmUri });

        if (pipeline) {
            // Child pipeline belongs to this parent, update it
            if (pipeline.configPipelineId === this.id) {
                pipeline.admins = admins;

                return pipeline.update();
            }

            // Child pipline does not belong to this parent, return
            winston.error(`Pipeline ${scmUrl} already exists: ${pipeline.id}`);

            return null;
        }

        return pipelineFactory.create({
            admins,
            scmContext,
            scmUri,
            configPipelineId: this.id
        });
    }

    /**
     * Remove a pipeline given a scmUrl
     * @method _removePipeline
     * @param {String} scmUrl  checkout url for a repository
     * @return {Promise}
     */
    async _removePipeline(scmUrl) {
        const pipelineFactory = this._getPipelineFactory();
        const scmUri = await this._getScmUri(scmUrl);

        const hasAdminPermission = await this._hasAdminPermission(scmUri);

        if (!hasAdminPermission) {
            // need to figure out how to bubble up this err to user
            winston.error(`Admins of ${this.pipelineId} has no admin permission to ${scmUrl}`);

            return null;
        }

        const pipeline = await pipelineFactory.get({ scmUri });

        return pipeline ? pipeline.remove() : null;
    }

    /**
     * Sync child pipelines given scmUrls
     * @method syncChildPipelines
     * @param {Array} scmUrls  An array of scmUrls for child pipelines
     * @return {Promise}
     */
    async _syncChildPipelines(scmUrls) {
        const toCreateOrUpdate = [];
        const toRemove = [];
        const oldScmUrls = hoek.reach(this.childPipelines, 'scmUrls') || [];
        const newScmUrls = scmUrls || [];
        // scmUrls in the old list but not the new list should be removed
        const scmUrlsToRemove = oldScmUrls.filter(scmUrl => !newScmUrls.includes(scmUrl));

        // create or update child pipelines
        newScmUrls.forEach(scmUrl => toCreateOrUpdate.push(this._createOrUpdatePipeline(scmUrl)));
        // remove child pipelines
        scmUrlsToRemove.forEach(scmUrl => toRemove.push(this._removePipeline(scmUrl)));

        return Promise.all([
            toCreateOrUpdate,
            toRemove
        ]);
    }

    /**
     * Sync the pipeline by looking up screwdriver.yaml
     * Create, update, or disable jobs if necessary.
     * Store/update the pipeline workflowGraph
     * @method sync
     * @param {String} [ref]  A reference to fetch the screwdriver.yaml, can be branch/tag/commit
     * @return {Promise}
     */
    sync(ref) {
        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        /* eslint-disable global-require */
        const JobFactory = require('./jobFactory');
        /* eslint-enable global-require */
        const factory = JobFactory.getInstance();

        // get the pipeline configuration
        return this.getConfiguration({ ref })
            .then((parsedConfig) => {
                // If it is an external config pipeline, sync all children
                if ((this.childPipelines || parsedConfig.childPipelines)
                    && !this.configPipelineId && !parsedConfig.errors) {
                    return this._syncChildPipelines(
                        hoek.reach(parsedConfig, 'childPipelines.scmUrls'))
                        .then(() => {
                            this.childPipelines = parsedConfig.childPipelines || null;

                            return parsedConfig;
                        });
                }

                return parsedConfig;
            }).then((parsedConfig) => {
                this.workflowGraph = parsedConfig.workflowGraph;
                this.annotations = parsedConfig.annotations;

                return this.jobs
                    .then((existingJobs) => {
                        const jobsToSync = [];
                        const jobsProcessed = [];
                        const triggersToSync = [];
                        const parsedConfigJobNames = Object.keys(parsedConfig.jobs);
                        const pipelineId = this.id;

                        // Loop through all existing jobs
                        existingJobs.forEach((job) => {
                            const jobName = job.name;
                            let requiresList = [];

                            // if it's in the yaml, update it
                            if (parsedConfigJobNames.includes(jobName)) {
                                const permutations = parsedConfig.jobs[jobName];

                                requiresList = permutations[0].requires || [];
                                job.permutations = permutations;
                                job.archived = false;
                                jobsToSync.push(job.update());
                            // if it's not in the yaml then archive it
                            } else if (!job.isPR()) {
                                job.archived = true;
                                jobsToSync.push(job.update());
                            }

                            // sync external triggers for existing jobs
                            triggersToSync.push(syncExternalTriggers({
                                pipelineId,
                                jobName,
                                requiresList
                            }));

                            // if it's a PR, leave it alone
                            jobsProcessed.push(job.name);
                        });

                        // Loop through all defined jobs in the yaml
                        Object.keys(parsedConfig.jobs).forEach((jobName) => {
                            const permutations = parsedConfig.jobs[jobName];
                            const jobConfig = {
                                pipelineId,
                                name: jobName,
                                permutations
                            };
                            const requiresList = permutations[0].requires || [];

                            // If the job has not been processed, create it (new jobs)
                            if (!jobsProcessed.includes(jobName)) {
                                jobsToSync.push(factory.create(jobConfig));

                                // sync external triggers for new jobs
                                triggersToSync.push(syncExternalTriggers({
                                    pipelineId: this.id,
                                    jobName,
                                    requiresList
                                }));
                            }
                        });

                        return Promise.all(triggersToSync)
                            .then(() => Promise.all(jobsToSync));
                    });
            })
            // wait until all promises have resolved
            .then((updatedJobs) => {
                // Add jobId to workflowGraph.nodes
                const nodes = this.workflowGraph.nodes;

                nodes.forEach((node) => {
                    const job = updatedJobs.find(j => j.name === node.name);

                    if (job) {
                        node.id = job.id;
                    }
                });

                // jobs updated or new jobs created during sync
                // delete it here so next time this.jobs is called a DB query will be forced and new jobs will return
                delete this.jobs;

                return this.update();
            })
            .then(() => this);
    }

    /**
     * Fetch the build admin
     * @property admin
     * @return {Promise}
    */
    get admin() {
        delete this.admin;

        const admin = this.getFirstAdmin();

        // ES6 has weird getters and setters in classes,
        // so we redefine the pipeline property here to resolve to the
        // resulting promise and not try to recreate the factory, etc.
        Object.defineProperty(this, 'admin', {
            enumerable: true,
            value: admin
        });

        return admin;
    }

    /** Fetch a pipeline's tokens
    /* @property tokens
    /* @return {Promise}
    */
    get tokens() {
        const listConfig = {
            params: {
                pipelineId: this.id
            }
        };

        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        /* eslint-disable global-require */
        const TokenFactory = require('./tokenFactory');
        /* eslint-enable global-require */
        const factory = TokenFactory.getInstance();
        const tokens = factory.list(listConfig);

        // ES6 has weird getters and setters in classes,
        // so we redefine the pipeline property here to resolve to the
        // resulting promise and not try to recreate the factory, etc.
        Object.defineProperty(this, 'tokens', {
            enumerable: true,
            value: tokens
        });

        return tokens;
    }

    /**
     * This function deletes admins who does not have proper
     * GitHub permission, and returns an proper admin.
     * @method getFirstAdmin
     * @return {Promise}
     */
    async getFirstAdmin() {
        const newAdmins = this.admins;

        /* eslint-disable global-require */
        const UserFactory = require('./userFactory');
        /* eslint-enable global-require */
        const factory = UserFactory.getInstance();

        /* eslint-disable no-restricted-syntax */
        for (const username of Object.keys(this.admins)) {
            // Lazy load factory dependency to prevent circular dependency issues
            // https://nodejs.org/api/modules.html#modules_cycles
            // eslint-disable-next-line no-await-in-loop
            const user = await factory.get({
                username,
                scmContext: this.scmContext
            });

            // eslint-disable-next-line no-await-in-loop
            const permission = await user.getPermissions(this.scmUri);

            if (!permission.push) {
                delete newAdmins[username];
                winston.info(`${username} has been removed from admins of pipeline:${this.id}.`);
            } else {
                break;
            }
        }
        /* eslint-enable no-restricted-syntax */

        if (Object.keys(newAdmins).length === 0) {
            winston.error(`Pipeline:${this.id} has no admin.`);
            throw new Error('Pipeline has no admin');
        } else {
            // This is needed to make admins dirty and update db
            this.admins = newAdmins;

            const result = await factory.get({
                username: Object.keys(this.admins)[0],
                scmContext: this.scmContext
            });

            return result;
        }
    }

    /**
     * Get the token of the pipeline admin
     * @property token
     * @return {Promise} Resolves the admin's token
     */
    get token() {
        return this.admin.then(admin => admin.unsealToken());
    }

    /**
     * Get the branch of the pipeline
     * @property branch
     * @return {Promise}
     */
    get branch() {
        if (!this.scmUri || this.scmUri === '') {
            return Promise.resolve('');
        }
        const uriInfos = this.scmUri.split(':');

        if (uriInfos.length < 3) {
            return Promise.resolve('');
        }

        return Promise.resolve(uriInfos[2]);
    }

    /**
     * Fetch all jobs that belong to this pipeline
     * @property jobs
     * @return {Promise}
    */
    get jobs() {
        const listConfig = {
            params: {
                pipelineId: this.id
            }
        };

        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        /* eslint-disable global-require */
        const JobFactory = require('./jobFactory');
        /* eslint-enable global-require */
        const factory = JobFactory.getInstance();

        const jobs = factory.list(listConfig);

        // ES6 has weird getters and setters in classes,
        // so we redefine the pipeline property here to resolve to the
        // resulting promise and not try to recreate the factory, etc.
        Object.defineProperty(this, 'jobs', {
            configurable: true,
            enumerable: true,
            value: jobs
        });

        return jobs;
    }

    /**
     * Fetch all secrets that belong to this pipeline
     * @property secrets
     * @return Promise
    */
    get secrets() {
        const listConfig = {
            params: {
                pipelineId: this.id
            }
        };

        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        /* eslint-disable global-require */
        const SecretFactory = require('./secretFactory');
        /* eslint-enable global-require */
        const factory = SecretFactory.getInstance();

        let secrets = factory.list(listConfig);

        // Fetch and merge config pipeline's secrets
        if (this.configPipelineId) {
            const configPipelineListConfig = hoek.clone(listConfig);

            configPipelineListConfig.params.pipelineId = this.configPipelineId;

            return Promise.all([
                secrets,
                factory.list(configPipelineListConfig)
            ]).then((results) => {
                // Merge config pipeline's secrets into this pipeline's
                secrets = _.uniqBy([...results[0], ...results[1]], 'name');

                // ES6 has weird getters and setters in classes,
                // so we redefine the pipeline property here to resolve to the
                // resulting promise and not try to recreate the factory, etc.
                Object.defineProperty(this, 'secrets', {
                    enumerable: true,
                    value: secrets
                });

                return secrets;
            });
        }

        Object.defineProperty(this, 'secrets', {
            enumerable: true,
            value: secrets
        });

        return secrets;
    }

    /**
     * Fetch the config pipeline if it exists
     * @property configPipeline
     * @return   {Promise}
     */
    get configPipeline() {
        const pipelineFactory = this._getPipelineFactory();

        return pipelineFactory.get(this.configPipelineId);
    }

    /**
     * Fetch jobs belong to a pipeline.
     * @param  {Object}   [config]                  Configuration object
     * @param  {Object}   [config.params]           Filter params
     * @param  {Boolean}  [config.params.archived]  Get archived/non-archived jobs
     * @param  {String}   [config.type]             Type of jobs (pr or pipeline)
     * @param  {Object}   [config.paginate]         Pagination parameters
     * @param  {Number}   [config.paginate.count]   Number of items per page
     * @param  {Number}   [config.paginate.page]    Specific page of the set to return
     * @return {Promise}  Resolves to an array of jobs
     */
    getJobs(config) {
        const defaultConfig = {
            params: {
                pipelineId: this.id,
                archived: false
            }
        };
        const listConfig = (config) ? hoek.applyToDefaults(defaultConfig, config) : defaultConfig;

        if (listConfig.type) {
            delete listConfig.type;
        }

        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        /* eslint-disable global-require */
        const JobFactory = require('./jobFactory');
        /* eslint-enable global-require */
        const jobFactory = JobFactory.getInstance();

        return jobFactory.list(listConfig)
            .then((jobs) => {
                // get PR jobs
                const prJobs = jobs
                    .filter(j => j.isPR() && j.archived === listConfig.params.archived)
                    .sort((job1, job2) => job1.prNum - job2.prNum);

                const pipelineJobs = jobs
                    .filter(j => !j.isPR() && j.archived === listConfig.params.archived);

                if (config && config.type === 'pr') {
                    return prJobs;
                }
                if (config && config.type === 'pipeline') {
                    return pipelineJobs;
                }

                return pipelineJobs.concat(prJobs);
            });
    }

    /**
     * Fetch events belong to a pipeline.
     * @param  {Object}   [config]
     * @param  {Number}   [config.sort]                         Sort rangekey by ascending or descending
     * @param  {Number}   [config.params.type = 'pipeline']     Get pipeline or pr events
     * @param  {Object}   [config.paginate]                     Pagination parameters
     * @param  {Number}   [config.paginate.count]               Number of items per page
     * @param  {Number}   [config.paginate.page]                Specific page of the set to return
     * @return {Promise}  Resolves to an array of events
     */
    getEvents(config) {
        const defaultConfig = {
            params: {
                pipelineId: this.id,
                type: 'pipeline'
            },
            sort: 'descending'
        };

        const listConfig = config ? hoek.applyToDefaults(defaultConfig, config) : defaultConfig;

        // Lazy load factory dependency to prevent circular dependency issues
        // https://nodejs.org/api/modules.html#modules_cycles
        /* eslint-disable global-require */
        const EventFactory = require('./eventFactory');
        /* eslint-enable global-require */
        const factory = EventFactory.getInstance();

        return factory.list(listConfig);
    }

    /**
     * Update the repository and branch
     * @method update
     * @return {Promise}
     */
    update() {
        return this.admin
            .then(user => user.unsealToken())
            .then(token => this.scm.decorateUrl({
                scmUri: this.scmUri,
                scmContext: this.scmContext,
                token
            }))
            .then((scmRepo) => {
                this.scmRepo = scmRepo;

                return super.update();
            });
    }

    /**
     * Remove all jobs & builds associated with this pipeline and the pipeline itself
     * @return {Promise}        Resolves to null if remove successfully
     */
    remove() {
        const pipelineFactory = this._getPipelineFactory();

        const removeJobs = (archived =>
            this.getJobs({
                params: {
                    archived
                }
            }).then((jobs) => {
                if (jobs.length === 0) {
                    return null;
                }

                return Promise.all(jobs.map(job => job.remove()))
                    .then(() => removeJobs(archived));
            }));

        const removeEvents = (type =>
            this.getEvents({
                params: {
                    type
                }
            })
                .then((events) => {
                    if (events.length === 0) {
                        return null;
                    }

                    return Promise.all(events.map(event => event.remove()))
                        .then(() => removeEvents(type));
                }));

        const removeChildPipelines = (() =>
            pipelineFactory.list({
                params: {
                    configPipelineId: this.id
                }
            })
                .then(pipelines => Promise.all(pipelines.map(p => p.remove()))));

        const removeTokens = (() =>
            this.tokens.then(tokens => Promise.all(tokens.map(t => t.remove()))));

        return this.secrets
            .then((secrets) => { // remove secrets
                const filteredSecrets = secrets.filter(secret => secret.pipelineId === this.id);

                return Promise.all(filteredSecrets.map(secret => secret.remove()));
            })
            .then(() => removeTokens()) // remove tokens
            .then(() => removeJobs(true)) // remove archived jobs
            .then(() => removeJobs(false)) // remove non-archived jobs
            .then(() => removeEvents('pipeline')) // remove pipeline events
            .then(() => removeEvents('pr')) // remove pr events
            .then(() => removeChildPipelines()) // remove pr events
            .then(() => super.remove()); // remove pipeline
    }
}

module.exports = PipelineModel;

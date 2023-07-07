// Imports
import airtable from 'airtable';

// Secret constants
const { AIRTABLE_API_TOKEN, OPTIMIZELY_API_TOKEN } = process.env;

// Fixed IDs within Airtable
const BASE_ID = 'apprz55Uggo1JWTSV';
const TABLE_NAME = 'Results export';

// Base URL of Optimizely API
const OPTIMIZELY_API_BASE_URL = 'https://api.optimizely.com/v2';

// Authentication headers for Optimizely API
const OPTIMIZELY_API_DEFAULT_HEADERS = {
  headers: {
    Authorization: `Bearer ${OPTIMIZELY_API_TOKEN}`,
  },
};

// Authentication for Airtable SDK
airtable.configure({ apiKey: AIRTABLE_API_TOKEN })
const table = airtable.base(BASE_ID)(TABLE_NAME);

// Get a dictionary which maps Optimizely experiment IDs to Airtable record IDs
const getAirtableRecords = () => {
  // Return a Promise so we can await the response
  return new Promise((resolve, reject) => {
    // Start with empty map
    let result = {};

    // NOTE: I don't understand how to get pagination working
    table.select({
        fields: ['ID']
    }).eachPage((records, next) => {

      // Add each record on current page to the map
      records.forEach((record) => {
        const recordId = record.id;
        const experimentId = parseInt(record.fields['ID']);
        result[experimentId] = recordId;
      });

      next();

    }, (error) => {
        // Resolve promise
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
    });
  });
};

const createAirtableRecord = (fields) => {
  // Return a Promise so we can await the response
  return new Promise((resolve, reject) => {
    // Create new record
    table.create([
      { fields }
    ], {
      typecast: true
    }, (error, result) => {
      // Resolve promise
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
};

const updateAirtableRecord = (id, fields) => {
  // Return a Promise so we can await the response
  return new Promise((resolve, reject) => {
    // Create new record
    table.update([
      { id, fields }
    ], {
      typecast: true
    }, (error, result) => {
      // Resolve promise
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
};

const deleteAirtableRecords = (ids) => {
  // Return a Promise so we can await the response
  return new Promise((resolve, reject) => {
    // No need to make request when nothing to delete
    if (ids.length === 0) {
      resolve([]);
      return;
    }

    // Create new record
    table.destroy(ids, (error, result) => {
      // Resolve promise
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
};

// Combine project, experiment and results into Airtable fields
const buildAirtableFields = (project, experiment, results) => {
  // Set base line of fields
  let fields = {
    'Name': experiment.name,
    'ID': experiment.id,
    'Project': project.name,
    'Status': experiment.status
  };

  // Add additional fields from results
  if (results && results.metrics) {
    fields = {
      'Start': results.start_time,
      'End': results.end_time,
      ...fields
    };

    // Find the revenue metric (instead of just the primary metric)
    const metric = results.metrics.find(({name, field, aggregator}) => {
      return name === 'Universal Sale' && field === 'revenue' && aggregator === 'sum'
    });

    // Find the variation with the highest improvement
    const winningVariation = Object.values(metric.results).reduce((acc, variation) => {
      if (!variation.lift) {
        return acc;
      }
      if (!acc || !acc.lift) {
        return variation;
      }
      // Compare lift
      if (acc.lift.value > variation.lift.value) {
        return acc;
      } else {
        return variation;
      }
    });

    // Add even more additional fields from treatment uplift
    if (winningVariation && winningVariation.lift) {
      const { lift, value } = winningVariation;

      // Don't just show MAX INT
      if (lift.visitors_remaining === 9223372036854776000) {
        lift.visitors_remaining = null;
      }

      fields = {
        'Total Revenue': value / 100.0, // Revenue is given in cents
        'Improvement': lift.value,
        'Statistical Significance': lift.significance,
        'Remaining Visitors': lift.visitors_remaining,
        ...fields
      };

      if (lift.confidence_interval) {
        fields = {
          'Confidence Interval - Lower Bound': lift.confidence_interval[0],
          'Confidence Interval - Upper Bound': lift.confidence_interval[1],
          ...fields
        };
      }
    }
  }

  return fields;
};

// Helper function for making request to Optimizely API
const optimizelyApi = async (path) => {
  const url = `${OPTIMIZELY_API_BASE_URL}${path}`;
  const response = await fetch(url, OPTIMIZELY_API_DEFAULT_HEADERS);

  // Optimizely API might return 204 No Content
  if (response.status === 204) {
    return null;
  } else {
    return await response.json();
  }
};

// Get list of all active projects
const getOptimizelyProjects = () => {
  return optimizelyApi('/projects');
};

// Get experiments in project
const getOptimizelyExperiments = (projectId) => {
  // NOTE: might need to implement pagination
  return optimizelyApi(`/experiments?project_id=${projectId}&per_page=100`);
};

// Get results of an experiment
const getOptimizelyResults = (experimentId) => {
  return optimizelyApi(`/experiments/${experimentId}/results`);
};

// Main function
export const handler = async () => {
  console.log('Starting import...');

  // // Get current records in Airtable
  let records = await getAirtableRecords(table);

  // Get all projects
  const projects = await getOptimizelyProjects();

  // Iterate over all projects asynchronously
  await Promise.all(projects.map(async (project) => {

    // Skipping "Dev Test Project"
    if (project.name === 'Dev Test Project') {
      return;
    }

    // Get all experiments
    const experiments = await getOptimizelyExperiments(project.id);

    // Iterate over all experiments asynchronously
    await Promise.all(experiments.map(async (experiment) => {

      // Skip experiments which are archived
      // Unfortunately the API does not have this filter
      if (experiment.status === 'archived') {
        return;
      }

      // Get results for experiment only if the experiment is started
      let results = null;
      if (experiment.status !== 'not_started') {
        results = await getOptimizelyResults(experiment.id);
      }

      // Combine all data into fields for Airtable
      const fields = buildAirtableFields(project, experiment, results);

      if (experiment.id in records) {
        // Update existing record
        const recordId = records[experiment.id];
        await updateAirtableRecord(recordId, fields);

        // Mark as done
        delete records[experiment.id];
      } else {
        // Insert new record
        await createAirtableRecord(fields);
      }
    }));
  }));

  // Remove records that no longer exist
  console.log('Cleaning up...');
  await deleteAirtableRecords(Object.values(records));

  console.log('Import completed!');
};

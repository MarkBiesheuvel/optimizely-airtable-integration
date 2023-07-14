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
    // Update record
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

const deleteAirtableRecord = (id) => {
  // Return a Promise so we can await the response
  return new Promise((resolve, reject) => {
    // Delete record
    table.destroy([id], (error, result) => {
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
const buildAirtableFields = (experiment, results, variation, metric) => {
  // Set base line of fields
  let fields = {
    'Experiment Name': experiment.name,
    'Variation Name': variation.name,
    'ID': variation.variation_id,
    // 'Project': experiment.project_name,
    'Status': experiment.status
  };

  // Add additional fields from results
  if (results) {
    fields = {
      'Start': results.start_time,
      'End': results.end_time,
      ...fields
    };
  }

  // Add field from reach
  if (results && results.reach && variation.variation_id in results.reach.variations) {
    const { count } = results.reach.variations[variation.variation_id];

    fields = {
      'Total Visitors': count,
      ...fields
    };
  }

  // Add fields from metric
  if (metric && variation.variation_id in metric.results) {
    const { lift, value } = metric.results[variation.variation_id];

    fields = {
      'Total Revenue': value / 100.0, // Revenue is given in cents
      ...fields
    };

    if (lift) {
      // Don't just show MAX INT
      if (lift.visitors_remaining === 9223372036854776000) {
        lift.visitors_remaining = null;
      }

      fields = {
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

const buildAirtableRows = (experiment, results) => {
  let metric = null;
  if (results && results.metrics) {
    // Find the revenue metric (instead of just the primary metric)
    metric = results.metrics.find(({name, field, aggregator}) => {
      return name === 'Universal Sale' && field === 'revenue' && aggregator === 'sum'
    });
  }

  // Create a row for each variation
  return experiment.variations.map((variation) => {
    return buildAirtableFields(experiment, results, variation, metric);
  });
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
  // Get all projects
  console.log('Retrieving Optimizely projects...');
  const projects = await getOptimizelyProjects();

  // Iterate over all projects asynchronously
  console.log('Retrieving Optimizely experiments...');
  let experiments = await Promise.all(projects.map(async (project) => {
    // Skipping dev/qa projects
    if (project.name === 'Dev Test Project' || project.name === 'QA Project (July 2023)') {
      return;
    }

    // Get all experiments
    return getOptimizelyExperiments(project.id);
  }));

  // Combine experiments from different projects into single array
  experiments = experiments.flat().filter(e => !!e);

  // Iterate over all experiments asynchronously
  console.log('Retrieving Optimizely results...');
  let variations = await Promise.all(experiments.map(async (experiment) => {
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
    return buildAirtableRows(experiment, results);
  }));

  // Combine variations from different experiments into single array
  variations = variations.flat().filter(v => !!v);

  console.log('Reading records from Airtable...');
  // Get current records in Airtable
  const records = await getAirtableRecords(table);

  // Updating in Airtable
  console.log('Creating/updating Airtable records...');
  await Promise.all(variations.map(async (fields) => {
    const id = fields['ID'];

    if (id in records) {
      // Update existing record
      await updateAirtableRecord(records[id], fields);

      // Mark as done
      delete records[id];
    } else {
      // Insert new record
      await createAirtableRecord(fields);
    }
  }));

  // Remove records that no longer exist
  console.log('Deleting Airtable records...');
  await Promise.all(Object.values(records).map(async (recordId) => {
    await deleteAirtableRecord(recordId);
  }));

  console.log('Import completed!');
};

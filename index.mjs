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
    // Start with empty array
    let result = [];

    // NOTE: I don't understand how to get pagination working
    table.select({
        fields: []
    }).eachPage((records, next) => {

      // Add each record on current page to the map
      records.forEach((record) => {
        result.push(record.id);
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

const createAirtableRecords = (rows) => {
  // Return a Promise so we can await the response
  return new Promise((resolve, reject) => {
    // Create new record
    table.create(rows, {
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
const buildAirtableFields = (project, experiment, results, variation, metric) => {
  // Set base line of fields
  let fields = {
    'Experiment Name': experiment.name,
    'Variation Name': variation.name,
    'ID': variation.variation_id,
    'Project': project.name,
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

const buildAirtableRows = (project, experiment, results) => {
  let metric = null;
  if (results && results.metrics) {
    // Find the revenue metric (instead of just the primary metric)
    metric = results.metrics.find(({name, field, aggregator}) => {
      return name === 'Universal Sale' && field === 'revenue' && aggregator === 'sum'
    });
  }

  // Create a row for each variation
  return experiment.variations.map((variation) => {
    return {
      fields: buildAirtableFields(project, experiment, results, variation, metric)
    };
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
  console.log('Reading current table...');
  // Get current records in Airtable
  let records = await getAirtableRecords(table);

  console.log('Clearing table...');
  // Remove all records
  await Promise.all(records.reduce((chunks, record, i) => {
    const j = Math.floor(i / 10);
    if (!chunks[j]) {
      chunks[j] = [record];
    } else {
      chunks[j].push(record);
    }
    return chunks;
  }, []).map(async (chunk) => {
    await deleteAirtableRecords(chunk);
  }));

  console.log('Retrieving Optimizely projects...');
  // Get all projects
  const projects = await getOptimizelyProjects();

  console.log('Inserting Airtable rows...');
  // Iterate over all projects asynchronously
  await Promise.all(projects.map(async (project) => {

    // Skipping "Dev Test Project"
    if (project.name === 'Dev Test Project' || project.name === 'QA Project (July 2023)') {
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
      const rows = buildAirtableRows(project, experiment, results);

      await createAirtableRecords(rows);
    }));
  }));

  console.log('Import completed!');
};

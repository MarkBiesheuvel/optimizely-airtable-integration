const { OPTIMIZELY_API_TOKEN } = process.env;

// Base URL of Optimizely API
const baseUrl = 'https://api.optimizely.com/v2';

// Authentication headers for API
const defaultHeaders = {
  headers: {
    Authorization: `Bearer ${OPTIMIZELY_API_TOKEN}`,
  },
};

// Get a dictionary which maps Optimizely experiment IDs to Airtable record IDs
const getAirtableRecords = async (table) => {
  const response = await table.selectRecordsAsync({
    fields: ['ID']
  });

  return Object.fromEntries(response.records.map((record) => {
    return [record.getCellValueAsString('ID'), record.id]
  }));
}

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
    const primaryMetric = results.metrics[0];

    fields = {
      'Start': new Date(results.start_time),
      'End': new Date(results.end_time),
      'Primary Metric': primaryMetric.name,
      ...fields
    };

    // Find the variation with the highest improvement
    const winningVariation = Object.values(primaryMetric.results).reduce((acc, variation) => {
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
      const { lift } = winningVariation;
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
}

// Helper function for making request to Optimizely API
const optimizelyApi = async (path) => {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, defaultHeaders);

  // Optimizely API might return 204 No Content
  if (response.status === 204) {
    return null;
  } else {
    return await response.json();
  }
}

// Get list of all active projects
const getProjects = () => {
  return optimizelyApi('/projects');
}

// Get experiments in project
const getExperiments = (projectId) => {
  // NOTE: might need to implement pagination
  return optimizelyApi(`/experiments?project_id=${projectId}&per_page=100`);
}

// Get results of an experiment
const getResults = (experimentId) => {
  return optimizelyApi(`/experiments/${experimentId}/results`);
}

// Main function
const handler = async () => {
  console.log('Start fetching experiment data...');

  // // Get Airtable table
  // const tableName = 'Results export';
  // const table = base.getTable(tableName);

  // // Get current records in Airtable
  // let records = await getAirtableRecords(table);
  // console.log(`Found ${Object.keys(records).length} records in Airtable`);
  let records = {};

  // Get all projects
  const projects = await getProjects();

  // Iterate over all projects asynchronously
  await Promise.all(projects.map(async (project) => {

    // Skipping "Dev Test Project"
    if (project.name === 'Dev Test Project') {
      return;
    }

    // Get all experiments
    const experiments = await getExperiments(project.id);

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
        results = await getResults(experiment.id);
      }

      // Combine all data into fields for Airtable
      const fields = buildAirtableFields(project, experiment, results);

      console.log(fields);

      // if (experiment.id in records) {
      //   // Update existing record
      //   const recordId = records[experiment.id];
      //   await table.updateRecordAsync(recordId, fields);

      //   // Mark as done
      //   records[experiment.id] = null;
      // } else {
      //   // Insert new record
      //   await table.createRecordAsync(fields);
      // }
    }));
  }));

  // Remove records that no longer exist
  console.log('Cleaning up...');
  await Promise.all(Object.values(records).map(async (recordId) => {
    if (recordId) {
      await table.deleteRecordAsync(recordId);
    }
  }));

  console.log('Operation complete!');
}

if (require.main === module) {
  handler();
}

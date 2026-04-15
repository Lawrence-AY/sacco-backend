import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

 
app.use(cors());
app.use(express.json());

 
const supabase = createClient(
  process.env.DB_URL,
  process.env.DB_KEY 
);

 
app.get('/', (req, res) => {
  res.send('Supabase + Express is running!');
});

 
app.get('/test', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('test')           
      .select('*');
      

    if (error) throw error;

    res.status(200).json({
      success: true,
      count:data.length,
      data: data
    });
  } catch (error) {
    console.error('Error fetching test data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
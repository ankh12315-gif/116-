export default function PredictionNotice({text,matching=false}:{text:string;matching?:boolean}){
 return <div className="prediction-notice" role="status">
  <div>{text}</div>
  {matching&&<div className="matching-line">正在匹配<span className="matching-dots" aria-hidden="true"/></div>}
 </div>;
}

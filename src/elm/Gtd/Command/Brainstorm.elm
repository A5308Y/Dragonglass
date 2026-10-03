module Gtd.Command.Brainstorm exposing (Command(..), encode)

{-| Commands the Brainstorm workflow alone is allowed to send.
-}

import Gtd.Command as Base
import Gtd.Id exposing (ActionId, ProjectId)
import Json.Encode as Encode


type Command
    = LoadProjectDetail ProjectId
    | SaveBrainstorm ActionId String (Maybe String) (Maybe String)
    | SaveProjectBrainstorm { projectId : String, purpose : String, desiredOutcome : String, ideas : String }
    | SaveStandaloneBrainstorm String String
    | ShuffleBrainstormWords
    | FocusBrainstormIdeas Int Int
    | ShowProject ProjectId
      -- The Project's Support Material, as on the Project page.
    | OpenFile String
    | OpenLink String
    | CreateSupportNote ProjectId String
    | CreateSupportFolder ProjectId String
    | ReadSupportNote ProjectId String
    | UpdateSupportNote ProjectId String String
    | LinkProjectFile ProjectId
    | UnlinkProjectFile ProjectId String
    | AddProjectLink ProjectId String String
    | RemoveProjectLink ProjectId String
      -- Asks the local model for more ideas and things to consider.
    | SuggestIdeas { topic : String, desiredOutcome : String, ideas : String, offered : List String }


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            LoadProjectDetail projectId ->
                Base.LoadProjectDetail projectId

            SaveBrainstorm actionId ideas outcome purpose ->
                Base.SaveBrainstorm actionId ideas outcome purpose

            SaveProjectBrainstorm plan ->
                Base.SaveProjectBrainstorm plan

            SaveStandaloneBrainstorm topic ideas ->
                Base.SaveStandaloneBrainstorm topic ideas

            ShuffleBrainstormWords ->
                Base.ShuffleBrainstormWords

            FocusBrainstormIdeas start end ->
                Base.FocusBrainstormIdeas start end

            ShowProject projectId ->
                Base.ShowProject projectId

            OpenFile path ->
                Base.OpenFile path

            OpenLink url ->
                Base.OpenLink url

            CreateSupportNote projectId title ->
                Base.CreateSupportNote projectId title

            CreateSupportFolder projectId path ->
                Base.CreateSupportFolder projectId path

            ReadSupportNote projectId path ->
                Base.ReadSupportNote projectId path

            UpdateSupportNote projectId path body ->
                Base.UpdateSupportNote projectId path body

            LinkProjectFile projectId ->
                Base.LinkProjectFile projectId

            UnlinkProjectFile projectId link ->
                Base.UnlinkProjectFile projectId link

            AddProjectLink projectId url title ->
                Base.AddProjectLink projectId url title

            RemoveProjectLink projectId entry ->
                Base.RemoveProjectLink projectId entry

            SuggestIdeas fields ->
                Base.SuggestBrainstormIdeas fields
        )
